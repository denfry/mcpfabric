#!/usr/bin/env node
/**
 * mcpfabric MCP server entrypoint.
 *
 * Registers every tool from the catalogue (`tools.ts`) as a thin forwarder to the in-game HTTP
 * bridge, then serves them over stdio (default) or streamable HTTP. All diagnostic logging goes to
 * stderr so it never corrupts the stdio JSON-RPC stream.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { loadConfig, type ServerConfig } from "./config.js";
import { BridgeClient, BridgeError, BridgeTimeoutError, BridgeUnreachableError } from "./bridge.js";
import { defaultDiscoveryPath, Discovery } from "./discovery.js";
import { TOOLS, type ToolDef } from "./tools.js";
import { isLocalRequest } from "./local-request.js";
import { drawMarks, pngSize } from "./marks.js";
import { groupOfMethod, READONLY, servesHints } from "./toolsets.js";
import { SupervisedSession } from "./supervised.js";
import { markUntrusted, UNTRUSTED_INSTRUCTIONS } from "./untrusted.js";
import { Channel, CHANNEL_CAPABILITY, CHANNEL_INSTRUCTIONS, CHANNEL_NOTIFICATION } from "./channel.js";
import { AgentRuntime, defaultDbPath } from "./agent/runtime.js";
import { AGENT_TOOLS, AgentSession } from "./agent/tools.js";
import { SCRIPT_TOOLS, ScriptHost } from "./script/tools.js";
import { registerDashboard } from "./dashboard/register.js";

// dist/index.js -> ../package.json, so the reported version always matches the published package.
const PKG_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

/** HTTP transport: sessions idle this long are closed, and at most MAX_HTTP_SESSIONS stay open. */
const SESSION_IDLE_MS = 30 * 60 * 1000;
const MAX_HTTP_SESSIONS = 32;
/** HTTP transport: largest request body read. MCP messages are small JSON; the bridge itself takes at most 1 MiB. */
const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;

class BodyTooLargeError extends Error {}

function log(...args: unknown[]): void {
  // stderr only — stdout is reserved for the stdio transport.
  console.error("[mcpfabric]", ...args);
}

function errorResult(err: unknown): CallToolResult {
  let text: string;
  if (err instanceof BridgeTimeoutError) {
    text = `Bridge timeout: ${err.message}`;
  } else if (err instanceof BridgeUnreachableError) {
    text = `Bridge unreachable: ${err.message}`;
  } else if (err instanceof BridgeError) {
    text = `Bridge error [${err.code}]: ${err.message}`;
    if (err.data !== undefined) text += `\n${JSON.stringify(err.data)}`;
  } else if (err instanceof Error) {
    text = `Error: ${err.message}`;
  } else {
    text = `Error: ${String(err)}`;
  }
  return { isError: true, content: [{ type: "text", text }] };
}

function jsonResult(result: unknown): CallToolResult {
  if (result === undefined || result === null) {
    return { content: [{ type: "text", text: "ok" }] };
  }
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  const out: CallToolResult = { content: [{ type: "text", text }] };
  if (typeof result === "object") {
    out.structuredContent = result as Record<string, unknown>;
  }
  return out;
}

interface ScreenshotResult {
  format?: string;
  base64: string;
  width?: number;
  height?: number;
  /** With `marks`: the entities in view and where they are in the image. */
  /** With `marks`: the entities in view and where they are in the frame (fractions of width and height). */
  marks?: { id: number; u: number; v: number; uuid: string; type: string; name?: string; distance: number }[];
}

function imageResult(result: unknown): CallToolResult {
  const r = result as ScreenshotResult;
  if (!r || typeof r.base64 !== "string") {
    return errorResult(new Error("Bridge did not return image data."));
  }
  const mimeType = r.format === "jpeg" || r.format === "jpg" ? "image/jpeg" : "image/png";
  let data = r.base64;
  let meta = `Screenshot ${r.width ?? "?"}x${r.height ?? "?"} (${mimeType})`;
  if (Array.isArray(r.marks) && r.marks.length > 0 && mimeType === "image/png") {
    const png = Buffer.from(r.base64, "base64");
    const { width, height } = pngSize(png);
    data = drawMarks(png, r.marks.map((m) => ({ id: m.id, x: m.u * width, y: m.v * height }))).toString("base64");
    const legend = r.marks.map((m) => `#${m.id} ${m.type.replace(/^minecraft:/, "")}${m.name ? ` "${m.name}"` : ""} · ${m.distance.toFixed(1)} m · uuid ${m.uuid}`);
    // Names can be set by other players: data, not instructions.
    meta += `\nmarks (names are untrusted text from the game):\n${legend.join("\n")}`;
  } else if (Array.isArray(r.marks)) {
    meta += "\nmarks: no mobs or players in view";
  }
  return {
    content: [
      { type: "image", data, mimeType },
      { type: "text", text: meta },
    ],
  };
}

function registerTools(server: McpServer, bridge: BridgeClient, supervised: SupervisedSession, groups: Set<string>): void {
  for (const def of TOOLS as ToolDef[]) {
    if (!groups.has(groupOfMethod(def.method)) || !servesHints(groups, def.annotations)) continue;
    const config = {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      ...(def.annotations ? { annotations: def.annotations } : {}),
    };

    const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
      try {
        const result = def.supervised ? await supervised.call(def.method, args ?? {}) : await bridge.call(def.method, args ?? {});
        if (def.kind === "image") return imageResult(result);
        return jsonResult(def.untrusted ? markUntrusted(result) : result);
      } catch (err) {
        return errorResult(err);
      }
    };

    server.registerTool(def.name, config, handler);
  }
}

/** Registers the agent tools; returns what to do when the MCP session closes. */
function registerAgentTools(server: McpServer, runtime: AgentRuntime, groups: Set<string>): () => void {
  const session = new AgentSession();
  for (const def of AGENT_TOOLS) {
    if (!servesHints(groups, def.annotations)) continue;
    const config = {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      ...(def.annotations ? { annotations: def.annotations } : {}),
    };
    const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
      try {
        const text = await def.run(runtime, session, args ?? {});
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorResult(err);
      }
    };
    server.registerTool(def.name, config, handler);
  }
  // A job must not keep moving the player after the session that started it is gone.
  return () => {
    void runtime.jobs.cancelOwnedBy(session.id).catch(() => undefined);
  };
}

/** Registers the script tools; returns what to do when the MCP session closes. */
function registerScriptTools(server: McpServer, host: ScriptHost): () => void {
  const owner = randomUUID();
  for (const def of SCRIPT_TOOLS) {
    if (def.needsRuntime && !host.runtime) continue;
    const config = {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: def.annotations,
    };
    const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
      try {
        const { text, isError } = await def.run(host, owner, args ?? {});
        return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
      } catch (err) {
        return errorResult(err);
      }
    };
    server.registerTool(def.name, config, handler);
  }
  // A script must not keep driving the player after the session that started it is gone.
  return () => host.cancelOwnedBy(owner);
}

const BASE_INSTRUCTIONS =
  "Control and observe a running Minecraft: Java Edition game (1.21.1 or newer, Fabric or NeoForge) through the mcpfabric mod. " +
  "Call get_status first to learn which side you are on and which capability groups are available. " +
  "Client-side tools (get_self, set_movement, look, break_block, place_block, use_item, screenshot, describe_scene, navigate_to, ...) drive the local player; " +
  "server-side tools (list_players, teleport_player, run_command, set_block, fill_blocks, query_entities, ...) require an integrated or dedicated server. " +
  "If client tools fail with no_client_player or the player stops reacting, call get_screen: close_screen leaves a pause menu or respawns, join_world rejoins a world or server from the menus. " +
  "The player can pause you at any time (get_status reports aiPaused): then actions are refused, so stop and talk to them with show_message instead of retrying.";

const AGENT_INSTRUCTIONS =
  " Agent runtime: memory, goals and the world map persist per world across sessions. Start with " +
  "agent_brief; keep a goal tree (goal_add/goal_update); observe after moving; remember what matters " +
  "and recall before searching the world again; use plan_craft before gathering. Multi-step actions " +
  "(travel_to, explore, collect_blocks, craft_item) run as background jobs — follow them with job_status " +
  "and do not drive movement manually while one runs.";

const SCRIPT_INSTRUCTIONS =
  " Code mode: for a sequence of many bridge calls (scan then act, loops, retries), write one run_script " +
  "program instead of calling tools one by one; keep programs that worked with save_skill and reuse them with run_skill.";

function buildServer(bridge: BridgeClient, runtime: AgentRuntime | undefined, scripts: ScriptHost | undefined, groups: Set<string>, channel = false): McpServer {
  const server = new McpServer(
    { name: "mcpfabric", version: PKG_VERSION },
    {
      instructions:
        BASE_INSTRUCTIONS + UNTRUSTED_INSTRUCTIONS + (runtime ? AGENT_INSTRUCTIONS : "") + (scripts ? SCRIPT_INSTRUCTIONS : "") + (channel ? CHANNEL_INSTRUCTIONS : ""),
      ...(channel ? { capabilities: { experimental: { [CHANNEL_CAPABILITY]: {} } } } : {}),
    },
  );
  const supervised = new SupervisedSession(bridge);
  registerTools(server, bridge, supervised, groups);
  const closeAgent = runtime ? registerAgentTools(server, runtime, groups) : undefined;
  // Scripts and the dashboard act (run tools, stop jobs), so a read-only server leaves them out.
  const writable = !groups.has(READONLY);
  const closeScripts = scripts && writable ? registerScriptTools(server, scripts) : undefined;
  if (runtime && writable) registerDashboard(server, runtime, bridge);
  // Grants of this MCP session must not outlive it.
  server.server.onclose = () => {
    closeAgent?.();
    closeScripts?.();
    void supervised.end();
  };
  return server;
}

async function runStdio(bridge: BridgeClient, runtime: AgentRuntime | undefined, scripts: ScriptHost | undefined, cfg: ServerConfig): Promise<void> {
  const server = buildServer(bridge, runtime, scripts, cfg.toolsets, cfg.channel.enabled);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`stdio transport ready (bridge: ${bridge.target().url})`);
  if (cfg.channel.enabled) startChannel(server, bridge, runtime, cfg);
}

/** Claude Code channel: one event stream, pushed into this (only) stdio session. */
function startChannel(server: McpServer, bridge: BridgeClient, runtime: AgentRuntime | undefined, cfg: ServerConfig): void {
  const channel = new Channel({
    cfg: cfg.channel,
    bridge,
    log,
    send: (message) =>
      // A Claude Code extension, outside the SDK's typed notification union.
      server.server.notification({ method: CHANNEL_NOTIFICATION, params: { ...message } } as unknown as ServerNotification),
  });
  const offJobs = runtime?.jobs.onEnd(channel.onJobEnd);
  channel.start();
  const previous = server.server.onclose;
  server.server.onclose = () => {
    previous?.();
    offJobs?.();
    void channel.stop();
  };
  log(`channel on (prefix "${cfg.channel.prefix}", whispers ${cfg.channel.whispers ? "on" : "off"}, at most ${cfg.channel.maxPerMinute}/min)`);
}

async function runHttp(bridge: BridgeClient, runtime: AgentRuntime | undefined, scripts: ScriptHost | undefined, cfg: ServerConfig): Promise<void> {
  // Stateful streamable-HTTP: one transport+server per session id.
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport; lastSeen: number }>();

  // Close sessions whose client went away without DELETE; otherwise they would stay open forever.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (now - entry.lastSeen > SESSION_IDLE_MS) {
        sessions.delete(id);
        void entry.transport.close();
      }
    }
  }, 60_000);
  sweep.unref();

  /** The JSON body, or undefined when empty or not JSON; throws BodyTooLargeError past MAX_HTTP_BODY_BYTES. */
  async function readBody(req: http.IncomingMessage): Promise<unknown> {
    if (Number(req.headers["content-length"]) > MAX_HTTP_BODY_BYTES) throw new BodyTooLargeError();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_HTTP_BODY_BYTES) throw new BodyTooLargeError();
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return undefined;
    }
  }

  const httpServer = http.createServer((req, res) => {
    // A request that fails (a client that hangs up mid-body, a transport error) must not take the
    // whole server down as an unhandled rejection.
    handle(req, res).catch((err: unknown) => {
      if (err instanceof BodyTooLargeError) {
        if (!res.headersSent) res.writeHead(413, { "Content-Type": "text/plain", Connection: "close" });
        res.end(`Request body larger than ${MAX_HTTP_BODY_BYTES} bytes.`);
        return;
      }
      // A client that hung up mid-request is not worth a log line; anything else is. (A fully read
      // request is already destroyed, so `req.destroyed` cannot tell the two apart.)
      const hungUp = req.readableAborted || (err as NodeJS.ErrnoException)?.code === "ECONNRESET";
      if (!hungUp) log("HTTP request failed:", err);
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(500, { "Content-Type": "text/plain", Connection: "close" }).end("Internal error.");
      } else {
        res.destroy();
      }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!req.url || !req.url.startsWith("/mcp")) {
      res.writeHead(404).end("Not found");
      return;
    }
    if (!isLocalRequest(req.headers, cfg.httpPort)) {
      res.writeHead(403, { "Content-Type": "text/plain" }).end("Forbidden: only local clients may use this server.");
      return;
    }
    const sessionId = req.headers["mcp-session-id"];
    const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;
    const body = req.method === "POST" ? await readBody(req) : undefined;

    let entry = sid ? sessions.get(sid) : undefined;
    if (entry) entry.lastSeen = Date.now();
    if (!entry) {
      if (sessions.size >= MAX_HTTP_SESSIONS) {
        res.writeHead(503, { "Content-Type": "text/plain" }).end("Too many open MCP sessions; close one (DELETE) or wait for idle ones to expire.");
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          sessions.set(id, entry!);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      const server = buildServer(bridge, runtime, scripts, cfg.toolsets);
      await server.connect(transport);
      entry = { server, transport, lastSeen: Date.now() };
    }
    await entry.transport.handleRequest(req, res, body);
  }

  httpServer.listen(cfg.httpPort, "127.0.0.1", () => {
    log(`streamable-HTTP transport ready on http://127.0.0.1:${cfg.httpPort}/mcp`);
  });
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  // Without MCPFABRIC_TOKEN, find the running game through the file the mod writes.
  const discovery = cfg.token ? undefined : new Discovery(defaultDiscoveryPath());
  const bridge = new BridgeClient(cfg.bridgeUrl, cfg.token, cfg.timeoutMs, discovery ? () => discovery.read() : undefined);
  if (discovery) log(`MCPFABRIC_TOKEN not set: connecting to the game found in ${discovery.path}`);

  // Best-effort connectivity hint (does not block startup; the mod may launch later).
  bridge
    .info()
    .then((info) => log("connected to bridge:", JSON.stringify(info)))
    .catch((err) => log("bridge not reachable yet:", (err as Error).message));

  let runtime: AgentRuntime | undefined;
  // The agent tools are a tool group too: leaving it out of MCPFABRIC_TOOLSETS turns the runtime off.
  if (cfg.agent && cfg.toolsets.has("agent")) {
    const dbPath = cfg.dataDir ? defaultDbPath({ MCPFABRIC_DATA_DIR: cfg.dataDir }) : defaultDbPath();
    try {
      runtime = new AgentRuntime(bridge, { dbPath, scripts: cfg.scripts, ...(cfg.world ? { worldOverride: cfg.world } : {}) });
      log(`agent runtime ready (memory: ${dbPath}, opened on first use)`);
    } catch (err) {
      // e.g. a Node build without node:sqlite: keep serving the plain bridge tools.
      log("agent runtime disabled:", (err as Error).message);
    }
  }

  // Scripts need only the bridge; their skills are kept in the agent database, so they need the runtime.
  // Scripts are a tool group too (`script`).
  const scripts = cfg.scripts && cfg.toolsets.has("script") ? new ScriptHost(bridge, runtime) : undefined;

  if (cfg.transport === "http") {
    if (cfg.channel.enabled) log("MCPFABRIC_CHANNEL needs the stdio transport; the channel stays off.");
    await runHttp(bridge, runtime, scripts, cfg);
  } else {
    await runStdio(bridge, runtime, scripts, cfg);
  }
}

main().catch((err) => {
  log("fatal:", err);
  process.exit(1);
});
