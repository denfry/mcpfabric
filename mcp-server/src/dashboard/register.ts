/**
 * The agent dashboard as an MCP App (https://modelcontextprotocol.io/extensions/apps): `open_dashboard`
 * shows a live panel (position, vitals, job, map, goals, inventory, STOP) in hosts that render MCP
 * Apps, and a text summary everywhere else. `dashboard_state` and `dashboard_stop` are app-only: the
 * panel calls them through the host, the model does not see them.
 */
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Bridge } from "../agent/body.js";
import type { AgentRuntime } from "../agent/runtime.js";
import { READ, ACT } from "../tools.js";
import { summarize, takeSnapshot } from "./snapshot.js";
import { dashboardHtml } from "./view.js";

export const DASHBOARD_URI = "ui://mcpfabric/dashboard.html";
/** Tools served with the agent runtime; the last two are visible to the panel only. */
export const DASHBOARD_TOOLS = ["open_dashboard", "dashboard_state", "dashboard_stop"];

function failure(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `Dashboard: ${(err as Error)?.message ?? String(err)}` }] };
}

/** Stops whatever moves the player: the running job, navigation, mining, held keys, supervised input. */
export async function stopEverything(rt: AgentRuntime, bridge: Bridge): Promise<string> {
  const job = await rt.jobs.cancel().catch(() => undefined);
  const steps = await Promise.allSettled([
    bridge.call("nav.stop"),
    bridge.call("control.stop"),
    bridge.call("interact.stopBreaking"),
    bridge.call("supervised.stop"),
  ]);
  const failed = steps.filter((s) => s.status === "rejected").length;
  return `Stopped${job ? ` job #${job.id} (${job.kind})` : ""}: movement, navigation and mining released` +
    (failed ? ` (${failed} of 4 stop calls failed; is the game running?)` : "") + ".";
}

export function registerDashboard(server: McpServer, rt: AgentRuntime, bridge: Bridge): void {
  registerAppResource(server, "Agent dashboard", DASHBOARD_URI, { description: "Live view of the Minecraft agent." }, async () => ({
    contents: [{ uri: DASHBOARD_URI, mimeType: RESOURCE_MIME_TYPE, text: dashboardHtml() }],
  }));

  registerAppTool(
    server,
    "open_dashboard",
    {
      title: "Open the agent dashboard",
      description:
        "Show the user a live panel of the agent: position, health and food, the running job, the explored map, the goal tree and the inventory, with a STOP button. It refreshes itself while open. In hosts without MCP Apps it returns a short text summary.",
      inputSchema: {},
      annotations: READ,
      _meta: { ui: { resourceUri: DASHBOARD_URI } },
    },
    async () => {
      try {
        const s = await takeSnapshot(rt, bridge);
        return { content: [{ type: "text", text: summarize(s) }], structuredContent: s as unknown as Record<string, unknown> };
      } catch (err) {
        return failure(err);
      }
    },
  );

  registerAppTool(
    server,
    "dashboard_state",
    {
      title: "Dashboard state",
      description: "Current snapshot for the open dashboard (called by the panel).",
      inputSchema: {},
      annotations: READ,
      _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ["app"] } },
    },
    async () => {
      try {
        const s = await takeSnapshot(rt, bridge);
        return { content: [{ type: "text", text: summarize(s) }], structuredContent: s as unknown as Record<string, unknown> };
      } catch (err) {
        return failure(err);
      }
    },
  );

  registerAppTool(
    server,
    "dashboard_stop",
    {
      title: "Stop the agent",
      description: "The dashboard's STOP button: cancel the running job and release movement, navigation, mining and supervised input.",
      inputSchema: {},
      annotations: { ...ACT, idempotentHint: true },
      _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ["app"] } },
    },
    async () => {
      try {
        return { content: [{ type: "text", text: await stopEverything(rt, bridge) }] };
      } catch (err) {
        return failure(err);
      }
    },
  );
}
