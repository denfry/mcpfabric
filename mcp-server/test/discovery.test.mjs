import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs against the compiled server: npm run build first (npm test does).
import { BridgeClient } from "../dist/bridge.js";
import { Discovery, parse } from "../dist/discovery.js";

function touch(file, date) {
  utimesSync(file, date, date);
}

test("parse accepts the mod's file and refuses anything else", () => {
  assert.deepEqual(parse('{"url":"http://127.0.0.1:25599","token":"abc","pid":42,"side":"client"}'), {
    url: "http://127.0.0.1:25599",
    token: "abc",
    pid: 42,
  });
  assert.deepEqual(parse('{"url":"http://127.0.0.1:25599"}'), { url: "http://127.0.0.1:25599", token: undefined });
  assert.equal(parse("not json"), undefined);
  assert.equal(parse('{"url":"https://example.com/x"}'), undefined);
  assert.equal(parse('{"url":"http://127.0.0.1:25599/rpc"}'), undefined);
  assert.equal(parse(undefined), undefined);
});

test("Discovery follows the file and ignores one left by a game that is gone", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpfabric-discovery-"));
  try {
    const file = join(dir, "bridge.json");
    const d = new Discovery(file);
    assert.equal(d.read(), undefined, "no file yet");
    writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:1111", token: "one", pid: process.pid }));
    assert.deepEqual(d.read(), { url: "http://127.0.0.1:1111", token: "one", pid: process.pid });
    // A rewrite (new mtime) is picked up.
    const later = new Date(Date.now() + 5000);
    writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:2222", token: "two", pid: process.pid }));
    touch(file, later);
    assert.equal(d.read()?.token, "two");
    // A pid that does not exist: the game crashed without removing the file.
    writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:3333", token: "three", pid: 2 ** 30 }));
    touch(file, new Date(Date.now() + 10000));
    assert.equal(d.read(), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the bridge client sends the discovered token to the discovered address, an explicit token wins", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result: { pong: true } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const discovered = new BridgeClient("http://127.0.0.1:9", undefined, 2000, () => ({ url, token: "found" }));
    assert.deepEqual(await discovered.call("info.status"), { pong: true });
    const explicit = new BridgeClient(url, "mine", 2000, () => ({ url: "http://127.0.0.1:9", token: "found" }));
    assert.deepEqual(await explicit.call("info.status"), { pong: true });
    assert.deepEqual(seen, ["Bearer found", "Bearer mine"]);
    const nothing = new BridgeClient("http://127.0.0.1:9", undefined, 500, () => undefined);
    await assert.rejects(nothing.call("info.status"), /127\.0\.0\.1:9/);
  } finally {
    server.close();
  }
});

test("MCPFABRIC_INSTANCE picks one of several running games by name, player, folder or pid", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpfabric-instances-"));
  try {
    const file = join(dir, "bridge.json");
    const bridges = join(dir, "bridges");
    mkdirSync(bridges);
    // Two live games (this process and its parent) and one that crashed.
    const game = (pid, port, extra) => {
      const f = join(bridges, `${pid}.json`);
      writeFileSync(f, JSON.stringify({ url: `http://127.0.0.1:${port}`, token: `t${port}`, pid, ...extra }));
      return f;
    };
    touch(game(process.pid, 25599, { name: "Builder", player: "Builder", gameDir: "pack-a" }), new Date(Date.now() - 5000));
    game(process.ppid, 25600, { name: "miner-bot", player: "Steve", gameDir: "pack-b" });
    game(2 ** 30, 25601, { name: "ghost" });
    writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:25600", token: "t25600", pid: process.ppid }));

    assert.equal(new Discovery(file, "builder").read()?.url, "http://127.0.0.1:25599", "by name, any case");
    assert.equal(new Discovery(file, "Steve").read()?.url, "http://127.0.0.1:25600", "by player");
    assert.equal(new Discovery(file, "pack-a").read()?.token, "t25599", "by game folder");
    assert.equal(new Discovery(file, String(process.ppid)).read()?.url, "http://127.0.0.1:25600", "by pid");
    assert.equal(new Discovery(file, "ghost").read(), undefined, "a game that is gone is not offered");
    assert.equal(new Discovery(file, "nobody").read(), undefined);
    // Without a name: the newest game's shared file, as before.
    assert.equal(new Discovery(file).read()?.url, "http://127.0.0.1:25600");
    assert.deepEqual(new Discovery(file).instances().map((i) => i.name), ["miner-bot", "Builder"], "newest first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
