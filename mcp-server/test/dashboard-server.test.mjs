import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

test("the dashboard is an MCP App: a ui:// resource and tools that point at it", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, MCPFABRIC_URL: "http://127.0.0.1:9", MCPFABRIC_TOKEN: "t", MCPFABRIC_DATA_DIR: mkdtempSync(join(tmpdir(), "mcpfabric-dash-")) },
    stderr: "ignore",
  });
  const client = new Client({ name: "dashboard-test", version: "0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const open = tools.find((t) => t.name === "open_dashboard");
    assert.equal(open?._meta?.ui?.resourceUri, "ui://mcpfabric/dashboard.html");
    const state = tools.find((t) => t.name === "dashboard_state");
    assert.deepEqual(state?._meta?.ui?.visibility, ["app"]);
    const { contents } = await client.readResource({ uri: "ui://mcpfabric/dashboard.html" });
    assert.equal(contents[0].mimeType, "text/html;profile=mcp-app");
    assert.ok(contents[0].text.includes("window.__mcpApps"));
  } finally {
    await client.close();
  }
});
