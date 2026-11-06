import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Runs against the compiled server: npm run build first (npm test does).
import { TOOLS } from "../dist/tools.js";
import { AGENT_TOOLS } from "../dist/agent/tools.js";
import { DASHBOARD_TOOLS } from "../dist/dashboard/register.js";
import { groupOfMethod, parseToolsets, TOOL_GROUPS, TOOL_PROFILES } from "../dist/toolsets.js";

const serverEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

test("every bridge tool belongs to a group, and every group has tools", () => {
  const used = new Set(["agent"]);
  for (const tool of TOOLS) used.add(groupOfMethod(tool.method));
  assert.deepEqual([...used].sort(), TOOL_GROUPS);
});

test("profiles only name known groups", () => {
  for (const [name, groups] of Object.entries(TOOL_PROFILES)) {
    for (const g of groups) assert.ok(TOOL_GROUPS.includes(g), `profile ${name} names unknown group ${g}`);
  }
});

test("parseToolsets: empty means all, info is always in, unknown names fail", () => {
  assert.deepEqual([...parseToolsets(undefined)].sort(), TOOL_GROUPS);
  assert.deepEqual([...parseToolsets(" ")].sort(), TOOL_GROUPS);
  assert.deepEqual([...parseToolsets("world")].sort(), ["info", "world"]);
  assert.deepEqual([...parseToolsets("supervised, Chat")].sort(), ["chat", "info", "supervised"]);
  assert.throws(() => parseToolsets("play,wrold"), /unknown tool set "wrold"/);
});

async function listTools(toolsets) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      ...process.env,
      MCPFABRIC_URL: "http://127.0.0.1:9",
      MCPFABRIC_TOKEN: "t",
      MCPFABRIC_TOOLSETS: toolsets,
      MCPFABRIC_DATA_DIR: mkdtempSync(join(tmpdir(), "mcpfabric-toolsets-")),
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "toolsets-test", version: "0" });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

test("the server only serves the tools of the chosen sets", async () => {
  const admin = await listTools("operator");
  const expected = TOOLS.filter((t) => ["info", "operator"].includes(groupOfMethod(t.method)))
    .map((t) => t.name)
    .sort();
  assert.deepEqual(admin, expected);
  assert.ok(admin.includes("run_command") && admin.includes("get_status"));

  const play = await listTools("play");
  assert.ok(play.includes("agent_brief"), "play serves the agent tools");
  assert.ok(play.includes("navigate_to") && !play.includes("run_command") && !play.includes("set_block"));
  assert.equal(play.length, TOOLS.filter((t) => TOOL_PROFILES.play.includes(groupOfMethod(t.method))).length + AGENT_TOOLS.length + DASHBOARD_TOOLS.length);
});
