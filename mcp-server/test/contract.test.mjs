import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Runs against the compiled server: npm run build first (npm test does).
import { AGENT_TOOLS } from "../dist/agent/tools.js";
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
  for (const tool of [...TOOLS, ...AGENT_TOOLS]) {
    for (const hint of hints) assert.equal(typeof tool.annotations?.[hint], "boolean", `${tool.name} lacks ${hint}`);
    if (tool.annotations.readOnlyHint) assert.equal(tool.annotations.destructiveHint, false, `${tool.name} is read-only but destructive`);
  }
  const run = TOOLS.find((tool) => tool.name === "run_command");
  assert.deepEqual(run.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
});

test("the read-only token allows exactly the methods of the read-only bridge tools", () => {
  const java = readFileSync(join(repoRoot, "src", "main", "java", "dev", "mcpfabric", "bridge", "ReadAccess.java"), "utf8");
  const block = /Set\.of\(([\s\S]*?)\);/.exec(java)[1];
  const allowed = new Set([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const registered = registeredMethods();
  assert.deepEqual([...allowed].filter((m) => !registered.has(m)).sort(), [], "ReadAccess lists methods the mod does not register");
  // Supervised reads run under a grant of a supervisor session, which only the full token can open.
  const readTools = TOOLS.filter((t) => t.annotations.readOnlyHint && !t.supervised);
  assert.deepEqual(readTools.filter((t) => !allowed.has(t.method)).map((t) => `${t.name} (${t.method})`).sort(), [], "read-only tools the read token cannot call");
  const writing = TOOLS.filter((t) => !t.annotations.readOnlyHint && allowed.has(t.method));
  assert.deepEqual(writing.map((t) => t.name).sort(), [], "ReadAccess allows a method of a tool that is not read-only");
});
