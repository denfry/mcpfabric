import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Runs against the compiled server: npm run build first (npm test does).
import { AGENT_TOOLS } from "../dist/agent/tools.js";
import { SCRIPT_TOOLS } from "../dist/script/tools.js";
import { TOOLS } from "../dist/tools.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function filesEndingWith(dir, suffix) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesEndingWith(path, suffix);
    return entry.name.endsWith(suffix) ? [path] : [];
  });
}

/** Bridge methods the mod registers (router.register("method", ...)) in src/. */
function registeredMethods() {
  const methods = new Set();
  for (const file of filesEndingWith(join(repoRoot, "src"), ".java")) {
    for (const match of readFileSync(file, "utf8").matchAll(/router\.register\("([^"]+)"/g)) methods.add(match[1]);
  }
  return methods;
}

/** Bridge methods the MCP server calls itself (bridge.call("method", ...)) in mcp-server/src/: the agent runtime, the supervisor session. */
function agentMethods() {
  const methods = new Set();
  for (const file of filesEndingWith(join(repoRoot, "mcp-server", "src"), ".ts")) {
    for (const match of readFileSync(file, "utf8").matchAll(/bridge\.call(?:<[^>]*>)?\(\s*"([^"]+)"/g)) methods.add(match[1]);
  }
  return methods;
}

test("every tool calls a bridge method the mod registers, and every method is used", () => {
  const registered = registeredMethods();
  const agent = agentMethods();
  assert.ok(agent.size > 0, "no bridge.call calls found under mcp-server/src/");
  const used = new Set([...TOOLS.map((tool) => tool.method), ...agent]);
  assert.ok(registered.size > 0, "no router.register calls found under src/");
  assert.deepEqual([...used].filter((m) => !registered.has(m)).sort(), [], "tools calling a method the mod does not register");
  assert.deepEqual([...registered].filter((m) => !used.has(m)).sort(), [], "registered methods no tool or agent skill uses");
});

test("every tool states all four MCP hints, consistently", () => {
  const hints = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
  for (const tool of [...TOOLS, ...AGENT_TOOLS, ...SCRIPT_TOOLS]) {
    for (const hint of hints) assert.equal(typeof tool.annotations?.[hint], "boolean", `${tool.name} lacks ${hint}`);
    if (tool.annotations.readOnlyHint) assert.equal(tool.annotations.destructiveHint, false, `${tool.name} is read-only but destructive`);
  }
  const run = TOOLS.find((tool) => tool.name === "run_command");
  assert.deepEqual(run.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  // A script can do what run_command and send_chat do.
  for (const name of ["run_script", "run_skill"]) {
    assert.deepEqual(SCRIPT_TOOLS.find((tool) => tool.name === name).annotations, run.annotations, `${name} hints`);
  }
});

test("tool names are unique across the bridge, agent and script tools", () => {
  const names = [...TOOLS, ...AGENT_TOOLS, ...SCRIPT_TOOLS].map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
});
