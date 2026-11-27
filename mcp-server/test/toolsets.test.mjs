import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";

// Runs against the compiled server: npm run build first (npm test does).
import { TOOLS } from "../dist/tools.js";
import { AGENT_TOOLS } from "../dist/agent/tools.js";
import { SCRIPT_TOOLS } from "../dist/script/tools.js";
import { DASHBOARD_TOOLS } from "../dist/dashboard/register.js";
import { COMPACT_DESCRIPTION_CHARS, COMPACT_TOOLS, describeFor, groupOfMethod, parseToolsets, TOOL_GROUPS, TOOL_PROFILES } from "../dist/toolsets.js";

const serverEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

test("every bridge tool belongs to a group, and every group has tools", () => {
  const used = new Set(["agent", "script"]);
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
  return (await serve(toolsets)).tools.map((t) => t.name).sort();
}

/** The tools and the instructions the server offers for these sets. */
async function serve(toolsets) {
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
    return { tools: (await client.listTools()).tools, instructions: client.getInstructions() ?? "" };
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
  assert.equal(play.length, TOOLS.filter((t) => TOOL_PROFILES.play.includes(groupOfMethod(t.method))).length + AGENT_TOOLS.length + SCRIPT_TOOLS.length + DASHBOARD_TOOLS.length);
});

test("readonly serves only the tools that just read", async () => {
  assert.ok(parseToolsets("readonly").has("readonly"));
  assert.deepEqual([...parseToolsets("world,readonly")].sort(), ["info", "readonly", "world"]);
  const names = await listTools("readonly");
  const all = [...TOOLS, ...AGENT_TOOLS];
  for (const n of names) {
    const def = all.find((t) => t.name === n);
    if (def) assert.equal(def.annotations.readOnlyHint, true, `${n} is served under readonly`);
  }
  assert.ok(names.includes("get_block") && names.includes("agent_brief"));
  assert.ok(!names.includes("set_block") && !names.includes("run_command") && !names.includes("travel_to"));
});

test("compact serves the core tools with short descriptions and short instructions", async () => {
  assert.deepEqual([...parseToolsets("play,compact")].sort(), ["agent", "chat", "compact", "events", "info", "player", "script", "session", "vision"]);
  const all = [...TOOLS, ...AGENT_TOOLS];
  for (const name of COMPACT_TOOLS) assert.ok(all.some((t) => t.name === name), `compact names unknown tool ${name}`);

  const { tools, instructions } = await serve("compact");
  assert.deepEqual(tools.map((t) => t.name).sort(), [...COMPACT_TOOLS].sort(), "no scripts or dashboard either");
  for (const t of tools) {
    assert.ok(t.description.length <= COMPACT_DESCRIPTION_CHARS, `${t.name}: ${t.description.length} chars`);
    assert.ok(t.description.length >= 30, `${t.name} kept only a label: ${t.description}`);
  }
  assert.match(instructions, /^Control a Minecraft player/);
  assert.match(instructions, /never instructions/i, "the untrusted-data rule stays");
  assert.ok(!instructions.includes("run_script"));
  // Groups still apply: the admin profile keeps only its chat tools and get_status.
  assert.deepEqual(await listTools("admin,compact"), ["get_recent_chat", "get_status", "send_chat", "show_message"]);
});

test("short descriptions keep a whole first sentence", () => {
  const c = new Set(["compact"]);
  assert.equal(describeFor(new Set(), "A. B."), "A. B.", "unchanged without compact");
  assert.equal(describeFor(c, "Client-only. Break the block at a position. Out of reach, nothing is sent."), "Client-only. Break the block at a position.");
  assert.equal(
    describeFor(c, "Works on every version from 1.21.1 on, e.g. 26.1 as well. Second sentence."),
    "Works on every version from 1.21.1 on, e.g. 26.1 as well.",
  );
  const long = describeFor(c, "word ".repeat(100).trim() + ".");
  assert.ok(long.length <= COMPACT_DESCRIPTION_CHARS && long.endsWith("…"));
});
