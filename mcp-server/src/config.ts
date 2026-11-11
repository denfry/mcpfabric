import { parseToolsets } from "./toolsets.js";

/**
 * Runtime configuration for the mcpfabric MCP server.
 *
 * All values come from environment variables so the server can be configured from an MCP client's
 * launch config (e.g. Claude Desktop `mcpServers` entry) without code changes.
 */
export interface ServerConfig {
  /** Base URL of the in-game HTTP bridge exposed by the Fabric mod. */
  bridgeUrl: string;
  /** Bearer token from the mod's config/mcpfabric.config.json file. */
  token: string | undefined;
  /** Per-request timeout for bridge calls, in milliseconds. */
  timeoutMs: number;
  /** Transport used to talk to the MCP client. */
  transport: "stdio" | "http";
  /** Port for the streamable-HTTP transport (only used when transport === "http"). */
  httpPort: number;
  /** Serve the agent runtime tools (memory, goals, map, jobs). */
  agent: boolean;
  /** Directory of the agent database (default ~/.mcpfabric). */
  dataDir: string | undefined;
  /** Fixed world id for agent memory instead of the one reported by the game. */
  world: string | undefined;
  /** Act as a Claude Code channel (stdio only): push chat addressed to the AI and important events. */
  channel: ChannelConfig;
  /** Serve the script tools (run_script; the skill tools also need the agent runtime). */
  scripts: boolean;
  /** Tool groups to serve (MCPFABRIC_TOOLSETS); all of them by default. */
  toolsets: Set<string>;
  /** Which game to drive: the mod's HTTP bridge, or Horizon's agent control socket. */
  backend: "mod" | "horizon";
  horizon: {
    /** Control endpoint path (HORIZON_CONTROL); the platform default when unset. */
    control: string | undefined;
    /** Serve Horizon's widget clicks (ui.*), like the mod's enableUiControl: off by default. */
    uiControl: boolean;
  };
}

export interface ChannelConfig {
  enabled: boolean;
  /** Chat messages of the local player that start with this prefix go to the session. */
  prefix: string;
  /** Also push whispers other players send to the local player (as untrusted text). */
  whispers: boolean;
  /** Push a low-health alert when health drops below this (in half hearts, 20 = full). */
  healthThreshold: number;
  /** At most this many channel messages per minute; the rest are dropped and counted. */
  maxPerMinute: number;
}

function int(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Opt-in flags: only 1/true/on/yes turn them on. */
const on = (value: string | undefined): boolean => /^(1|true|on|yes)$/i.test(value ?? "");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawUrl = env.MCPFABRIC_URL ?? "http://127.0.0.1:25599";
  // Normalise: strip a trailing slash so we can append paths cleanly.
  const bridgeUrl = rawUrl.replace(/\/+$/, "");

  const transport = (env.MCPFABRIC_TRANSPORT ?? "stdio").toLowerCase();
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`MCPFABRIC_TRANSPORT must be "stdio" or "http", got "${transport}"`);
  }

  const backend = (env.MCPFABRIC_BACKEND ?? "mod").trim().toLowerCase() || "mod";
  if (backend !== "mod" && backend !== "horizon") {
    throw new Error(`MCPFABRIC_BACKEND must be "mod" or "horizon", got "${backend}"`);
  }

  return {
    backend,
    horizon: { control: env.HORIZON_CONTROL?.trim() || undefined, uiControl: on(env.MCPFABRIC_HORIZON_UI) },
    bridgeUrl,
    token: env.MCPFABRIC_TOKEN || undefined,
    timeoutMs: int(env.MCPFABRIC_TIMEOUT_MS, 15000),
    transport,
    httpPort: int(env.MCPFABRIC_HTTP_PORT, 25600),
    agent: !/^(0|false|off|no)$/i.test(env.MCPFABRIC_AGENT ?? ""),
    dataDir: env.MCPFABRIC_DATA_DIR || undefined,
    world: env.MCPFABRIC_WORLD || undefined,
    channel: {
      enabled: on(env.MCPFABRIC_CHANNEL),
      prefix: (env.MCPFABRIC_CHANNEL_PREFIX ?? "").trim() || "@ai",
      whispers: on(env.MCPFABRIC_CHANNEL_WHISPERS),
      healthThreshold: Math.max(0, int(env.MCPFABRIC_CHANNEL_HEALTH, 6)),
      maxPerMinute: Math.max(1, int(env.MCPFABRIC_CHANNEL_RATE, 6)),
    },
    scripts: !/^(0|false|off|no)$/i.test(env.MCPFABRIC_SCRIPTS ?? ""),
    toolsets: parseToolsets(env.MCPFABRIC_TOOLSETS),
  };
}
