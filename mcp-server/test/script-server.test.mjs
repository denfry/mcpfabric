import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Runs against the compiled server: npm run build first (npm test does).
import { SCRIPT_TOOLS } from "../dist/script/tools.js";
import { TOOLS } from "../dist/tools.js";

const serverEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const TOKEN = "test-token";

/** Calls the fake bridge received, in order. */
const received = [];
let bridge;
let client;

before(async () => {
  // A fake mod bridge: answers player.getState, fails world.setBlock as a locked capability.
  bridge = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const reply = (body) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (req.url !== "/rpc") return reply({});
    const { method, params } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push({ method, params, auth: req.headers.authorization });
    if (method === "player.getState") return reply({ ok: true, result: { x: 1, y: 64, z: 2 } });
    if (method === "world.setBlock") return reply({ ok: false, error: { code: "capability_disabled", message: "World writes are disabled" } });
    return reply({ ok: true, result: { echoed: method } });
  });
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const { port } = bridge.address();

  // Without the agent runtime: run_script is served, the skill tools (which need its database) are not.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, MCPFABRIC_URL: `http://127.0.0.1:${port}`, MCPFABRIC_TOKEN: TOKEN, MCPFABRIC_AGENT: "0" },
    stderr: "ignore",
  });
  client = new Client({ name: "script-server-test", version: "0.0.0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  await new Promise((resolve) => bridge?.close(resolve));
});

test("the server serves run_script by default, with its hints, and the skill tools only with the runtime", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.deepEqual(names.filter((n) => !TOOLS.some((t) => t.name === n)), ["run_script"]);
  const listed = tools.find((t) => t.name === "run_script");
  const def = SCRIPT_TOOLS.find((t) => t.name === "run_script");
  assert.deepEqual(listed.annotations, def.annotations);
  assert.deepEqual(Object.keys(listed.inputSchema.properties).sort(), ["args", "code", "timeoutSeconds"]);
});

test("run_script drives the bridge with the token and reports bridge errors to the script", async () => {
  received.length = 0;
  const result = await client.callTool({
    name: "run_script",
    arguments: {
      code: `const me = await mc.get_self();
let locked;
try { await mc.set_block({ x: me.x, y: me.y, z: me.z, blockId: "minecraft:stone" }); } catch (e) { locked = e.code; }
try { await mc.call("supervised.status"); } catch (e) { mc.log(e.code); }
return { y: me.y, locked, tag: mc.args.tag };`,
      args: { tag: "t1" },
    },
  });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.match(result.content[0].text, /^script ok · 3 calls/, "the refused call counts too");
  assert.match(result.content[0].text, /result: \{"y":64,"locked":"capability_disabled","tag":"t1"\}/);
  assert.match(result.content[0].text, /log \(1 line\):\n {2}forbidden/);
  assert.deepEqual(
    received.map((c) => c.method),
    ["player.getState", "world.setBlock"],
  );
  assert.ok(received.every((c) => c.auth === `Bearer ${TOKEN}`));
});

test("a failing script is a tool error with its stack", async () => {
  const result = await client.callTool({ name: "run_script", arguments: { code: "\nnull.x" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^script failed · 0 calls/);
  assert.match(result.content[0].text, /error: TypeError: cannot read property 'x' of null/);
  assert.match(result.content[0].text, /script\.js:2/);
});
