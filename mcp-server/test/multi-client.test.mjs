import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// Runs against the compiled server: npm run build first (npm test does).
import { Fleet, MAX_CLIENTS, splitClient, withClient } from "../dist/fleet.js";
import { z } from "zod";

const serverEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

/** A fake game: answers every call with its own name, and only with its own token. */
async function fakeGame(name, token, received) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const reply = (status, body) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, {});
    if (req.url !== "/rpc") return reply(200, { ok: true, result: {} });
    const { method, params } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push({ game: name, method, params });
    if (method === "player.getState") return reply(200, { ok: true, result: { name, x: 0, y: 64, z: 0 } });
    return reply(200, { ok: true, result: { game: name, method } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

let dir;
let alpha;
let beta;
let client;
const received = [];

before(async () => {
  alpha = await fakeGame("alpha", "token-a", received);
  beta = await fakeGame("beta", "token-b", received);
  dir = mkdtempSync(join(tmpdir(), "mcpfabric-multi-"));
  mkdirSync(join(dir, "bridges"));
  // Two running games (both pids must be alive); bridge.json names the default one, alpha.
  writeFileSync(join(dir, "bridge.json"), JSON.stringify({ url: alpha.url, token: "token-a", pid: process.pid }));
  writeFileSync(join(dir, "bridges", `${process.pid}.json`), JSON.stringify({ url: alpha.url, token: "token-a", pid: process.pid, name: "alpha", player: "Alex" }));
  writeFileSync(join(dir, "bridges", `${process.ppid}.json`), JSON.stringify({ url: beta.url, token: "token-b", pid: process.ppid, name: "beta", player: "Steve" }));

  const env = { ...process.env, MCPFABRIC_DISCOVERY: join(dir, "bridge.json"), MCPFABRIC_MULTI_CLIENT: "1", MCPFABRIC_DATA_DIR: dir };
  delete env.MCPFABRIC_TOKEN;
  delete env.MCPFABRIC_INSTANCE;
  delete env.MCPFABRIC_TOOLSETS;
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], env, stderr: "ignore" });
  client = new Client({ name: "multi-client-test", version: "0.0.0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  await new Promise((resolve) => alpha?.server.close(resolve));
  await new Promise((resolve) => beta?.server.close(resolve));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("multi-client mode serves list_clients and a client parameter on every tool", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("list_clients"));
  // The dashboard follows the default game.
  const fixed = new Set(["list_clients", "open_dashboard", "dashboard_state", "dashboard_stop"]);
  const without = tools.filter((t) => !fixed.has(t.name) && !("client" in (t.inputSchema.properties ?? {})));
  assert.deepEqual(without.map((t) => t.name), [], "tools without a client parameter");
  for (const name of ["get_self", "agent_brief", "run_script"]) assert.ok(names.includes(name), name);

  const listed = await client.callTool({ name: "list_clients", arguments: {} });
  const { clients } = JSON.parse(listed.content[0].text);
  assert.deepEqual(clients.map((c) => [c.client, c.player, c.default]).sort(), [
    ["alpha", "Alex", true],
    ["beta", "Steve", false],
  ]);
  assert.ok(!listed.content[0].text.includes("token"), "tokens never reach the model");
  assert.ok(!listed.content[0].text.includes("127.0.0.1"), "addresses never reach the model");
});

test("a call goes to the game named by client, without client to the default game", async () => {
  received.length = 0;
  const named = await client.callTool({ name: "get_self", arguments: { client: "BETA" } });
  assert.equal(JSON.parse(named.content[0].text).name, "beta");
  const plain = await client.callTool({ name: "get_self", arguments: {} });
  assert.equal(JSON.parse(plain.content[0].text).name, "alpha");
  const byPlayer = await client.callTool({ name: "get_self", arguments: { client: "Steve" } });
  assert.equal(JSON.parse(byPlayer.content[0].text).name, "beta");
  // The default game named explicitly is the same game.
  const self = await client.callTool({ name: "get_self", arguments: { client: "alpha" } });
  assert.equal(JSON.parse(self.content[0].text).name, "alpha");
  assert.deepEqual(received.map((r) => r.game), ["beta", "alpha", "beta", "alpha"]);
  assert.ok(received.every((r) => !("client" in r.params)), "client is not sent to the game");
});

test("scripts run against the game named by client", async () => {
  received.length = 0;
  const result = await client.callTool({ name: "run_script", arguments: { client: "beta", code: "return (await mc.get_self()).name;" } });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.match(result.content[0].text, /result: "beta"/);
  assert.deepEqual(received.map((r) => r.game), ["beta"]);
});

test("an unknown client is refused with the names of the running games", async () => {
  const result = await client.callTool({ name: "get_self", arguments: { client: "gamma" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no running game named "gamma"; running now: (alpha, beta|beta, alpha)/);
});

// ----- Fleet on its own ----------------------------------------------------------------------

function source(instances) {
  return {
    instances: () => instances.map(({ target: _t, ...i }) => i),
    find: (want) => {
      const w = want.toLowerCase();
      return instances.find((i) => [i.name, i.player, i.pid !== undefined ? String(i.pid) : undefined].some((v) => v?.toLowerCase() === w));
    },
  };
}

function game(name, port, pid, player) {
  const url = `http://127.0.0.1:${port}`;
  return { name, url, pid, mtimeMs: 0, ...(player ? { player } : {}), target: { url, token: name } };
}

function fakeMember(url) {
  return { name: undefined, bridge: { target: () => ({ url, token: undefined }) } };
}

test("Fleet: two games with one name are told apart by pid; one member per game", async () => {
  const games = [game("Dev", 1, 101), game("Dev", 2, 102), game("main", 3, 103)];
  const made = [];
  const fleet = new Fleet(source(games), fakeMember("http://127.0.0.1:3"), (name, target) => {
    const m = { name, bridge: { target: () => target } };
    made.push(m);
    return m;
  });
  assert.deepEqual(fleet.list().map((c) => c.client), ["101", "102", "main"]);
  const a = await fleet.resolve("102");
  const b = await fleet.resolve("102");
  assert.equal(a, b);
  assert.equal(a.bridge.target().url, "http://127.0.0.1:2");
  assert.equal(await fleet.resolve("main"), fleet.main, "the default game is the main member");
  assert.equal(await fleet.resolve(undefined), fleet.main);
  assert.equal(made.length, 1);
});

test("Fleet: a stopped game is forgotten, and at most MAX_CLIENTS games are driven", async () => {
  const games = [game("main", 1, 1)];
  for (let i = 0; i <= MAX_CLIENTS; i++) games.push(game(`g${i}`, 100 + i, 200 + i));
  const cancelled = [];
  const fleet = new Fleet(source(games), fakeMember("http://127.0.0.1:1"), (name, target) => ({
    name,
    bridge: { target: () => target },
    runtime: { jobs: { cancel: async () => cancelled.push(name) }, close: () => undefined },
  }));
  for (let i = 0; i < MAX_CLIENTS; i++) await fleet.resolve(`g${i}`);
  await assert.rejects(fleet.resolve(`g${MAX_CLIENTS}`), /at most/);
  games.splice(1, 1); // g0 stops
  await fleet.resolve(`g${MAX_CLIENTS}`);
  assert.deepEqual(cancelled, ["g0"]);
  assert.equal(fleet.members().length, MAX_CLIENTS + 1);
});

test("withClient and splitClient", () => {
  const shape = withClient({ x: z.number() });
  assert.ok(z.object(shape).safeParse({ x: 1, client: "beta" }).success);
  assert.ok(z.object(shape).safeParse({ x: 1 }).success);
  assert.throws(() => withClient({ client: z.string() }), /already has a parameter named client/);
  assert.deepEqual(splitClient({ x: 1, client: " beta " }), { client: "beta", rest: { x: 1 } });
  assert.deepEqual(splitClient({ x: 1, client: "" }), { client: undefined, rest: { x: 1 } });
  assert.deepEqual(splitClient(undefined), { client: undefined, rest: {} });
});
