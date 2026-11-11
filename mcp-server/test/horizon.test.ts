import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BridgeError, BridgeUnreachableError } from "../src/bridge.js";
import { loadConfig } from "../src/config.js";
import { HorizonBridge } from "../src/horizon/bridge.js";
import { ControlConnection, defaultControlPath, readEndpoint, rest, word } from "../src/horizon/control.js";
import { mapEvent } from "../src/horizon/events.js";

type Reply = Record<string, unknown> | ((line: string) => Record<string, unknown> | Promise<Record<string, unknown>>);

/** A stand-in for Horizon's TCP control endpoint: `auth TOKEN`, then one JSON line per command line. */
async function fakeHorizon(replies: Record<string, Reply>, token = "t0k3n") {
  const dir = mkdtempSync(join(tmpdir(), "mcpfabric-horizon-test-"));
  const path = join(dir, "horizon-control.json");
  const lines: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let authed = false;
    let buffer = "";
    let chain = Promise.resolve();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        chain = chain.then(async () => {
          if (!authed) {
            authed = line === `auth ${token}`;
            socket.write(authed ? '{"ok":true}\n' : '{"error":"bad or missing token"}\n');
            if (!authed) socket.end();
            return;
          }
          lines.push(line);
          const name = line.split(" ")[0]!;
          const r = replies[line] ?? replies[name];
          const body = typeof r === "function" ? await r(line) : (r ?? { error: `unknown command ${name}` });
          socket.write(JSON.stringify(body) + "\n");
        });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  writeFileSync(path, JSON.stringify({ transport: "tcp", port, token }));
  return {
    path,
    lines,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const KEY = Buffer.alloc(32, 7);
const bridgeFor = (path: string, uiControl = false) => new HorizonBridge({ path, timeoutMs: 2000, uiControl, worldKey: () => KEY });

const STATE = {
  screen: "playing",
  world: "My World",
  dimension: "minecraft:overworld",
  gamemode: "survival",
  selected: 3,
  busy: null,
  player: { position: [10.5, 64, -3.5], yaw: 90, pitch: 10, health: 18, food: 17, saturation: 2, air: 300, on_ground: true, xp: { level: 4 } },
  time: { day: 2, day_time: 50000, time_of_day: 2000 },
  weather: { raining: true, thundering: false },
};

test("endpoint path follows Horizon's rules", () => {
  assert.equal(defaultControlPath({ HORIZON_CONTROL: "/x/c.json" }, "linux"), "/x/c.json");
  assert.match(defaultControlPath({}, "win32"), /horizon-control\.json$/);
  assert.equal(defaultControlPath({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux").replace(/\\/g, "/"), "/run/user/1000/horizon-control.sock");
  assert.deepEqual(readEndpoint("/run/x.sock", "linux"), { kind: "unix", path: "/run/x.sock" });
  assert.throws(() => readEndpoint(join(tmpdir(), "does-not-exist-horizon.json"), "linux"), /Agent Control/);
});

test("command words cannot split or extend a control line", () => {
  assert.equal(word("minecraft:oak_stairs[facing=east,half=top]", "block"), "minecraft:oak_stairs[facing=east,half=top]");
  assert.throws(() => word("stone\nquit", "block"));
  assert.throws(() => word("stone quit", "block"));
  assert.throws(() => rest("hi\r\nquit", "message"));
  assert.equal(rest("hello there", "message"), "hello there");
});

test("authenticates with the endpoint's token and refuses a wrong one", async () => {
  const fake = await fakeHorizon({ hello: { protocol: "0.1.0", release: "test", features: ["agent"] } });
  try {
    const conn = await ControlConnection.open(readEndpoint(fake.path), 2000);
    assert.deepEqual(await conn.send("hello", 2000), { protocol: "0.1.0", release: "test", features: ["agent"] });
    await assert.rejects(conn.send("two\nlines", 2000), /single line/);
    conn.close();
    const ep = readEndpoint(fake.path);
    await assert.rejects(ControlConnection.open({ ...ep, token: "wrong" } as typeof ep, 2000), /refused the control token/);
  } finally {
    await fake.close();
  }
});

test("an unreachable game is a BridgeUnreachableError", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpfabric-horizon-none-"));
  const path = join(dir, "horizon-control.json");
  writeFileSync(path, JSON.stringify({ transport: "tcp", port: 1, token: "x" }));
  try {
    await assert.rejects(bridgeFor(path).call("player.getState"), BridgeUnreachableError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maps state, inventory and errors to the mod's shapes", async () => {
  const fake = await fakeHorizon({
    state: STATE,
    block: (line) => ({ block: line.endsWith("10 65 -4") ? "minecraft:water" : "minecraft:air", loaded: true }),
    inventory: {
      selected: 2,
      hotbar: [{ slot: 0, item: "minecraft:stone_pickaxe", count: 1, damage: 3, max_damage: 131 }, { slot: 1, item: null }],
      main: [{ slot: 9, item: "minecraft:dirt", count: 12 }],
      armor: [{ slot: 500, part: "head", item: null }],
      offhand: { slot: 504, item: null },
      counts: { "minecraft:dirt": 12 },
    },
    "select": { error: "slot must be 1-9", kind: "usage" },
  });
  try {
    const h = bridgeFor(fake.path);
    const self = await h.call<Record<string, unknown>>("player.getState");
    assert.equal(self.x, 10.5);
    assert.equal(self.selectedSlot, 2);
    assert.equal(self.inWater, true); // eyes in water
    assert.equal(self.onGround, true);
    const inv = await h.call<{ selectedSlot: number; hotbar: unknown[]; main: unknown[] }>("player.getInventory");
    assert.equal(inv.selectedSlot, 1);
    assert.deepEqual(inv.hotbar, [{ slot: 0, id: "minecraft:stone_pickaxe", count: 1, damage: 3, maxDamage: 131 }]);
    assert.deepEqual(inv.main, [{ slot: 9, id: "minecraft:dirt", count: 12 }]);
    const tw = await h.call<Record<string, unknown>>("world.getTimeAndWeather");
    assert.equal(tw.dayTime, 2000);
    assert.equal(tw.raining, true);
    await assert.rejects(h.call("inventory.selectHotbar", { slot: 2 }), (e: unknown) => e instanceof BridgeError && e.code === "usage");
    await assert.rejects(h.call("inventory.selectHotbar", { slot: 9 }), /slot must be 0-8/);
  } finally {
    await fake.close();
  }
});

test("world ids: the save folder in singleplayer, an opaque keyed id on a server", async () => {
  let address = "local";
  const fake = await fakeHorizon({
    state: STATE,
    status: () => ({ server: { address } }),
    worlds: { worlds: [{ folder: "my_world", name: "My World" }] },
  });
  try {
    const h = bridgeFor(fake.path);
    assert.equal((await h.call<{ worldId: string }>("session.info")).worldId, "sp:my_world");
    address = "play.example.net";
    const mp = await h.call<{ worldId: string; name: string }>("session.info");
    assert.match(mp.worldId, /^mp:[0-9a-f]{16}$/);
    assert.ok(!JSON.stringify(mp).includes("example"), "the address never leaves the bridge");
    const other = new HorizonBridge({ path: fake.path, timeoutMs: 2000, uiControl: false, worldKey: () => Buffer.alloc(32, 9) });
    assert.notEqual((await other.call<{ worldId: string }>("session.info")).worldId, mp.worldId, "the id depends on the secret key");
  } finally {
    await fake.close();
  }
});

test("container state lists only the container's slots, numbered like the mod's menu", async () => {
  const slots = [
    { slot: 0, item: "minecraft:dirt", count: 5 },
    { slot: 9, item: "minecraft:stone", count: 2 },
    ...Array.from({ length: 27 }, (_, i) => (i === 4 ? { slot: 304, item: "minecraft:iron_ingot", count: 7 } : { slot: 300 + i, item: null })),
  ];
  const fake = await fakeHorizon({ screen: { screen: "container", slots, title: [{ text: "Chest" }] }, "click-slot": { ok: true } });
  try {
    const h = bridgeFor(fake.path);
    const st = await h.call<{ open: boolean; size: number; title: string; slots: unknown[] }>("container.state");
    assert.equal(st.open, true);
    assert.equal(st.size, 27);
    assert.equal(st.title, "Chest");
    assert.deepEqual(st.slots, [{ slot: 4, id: "minecraft:iron_ingot", count: 7 }]);
    // Menu slot 27 is the first main-inventory slot (Horizon 9); 54 is hotbar slot 0.
    await h.call("container.click", { slot: 27, mode: "pickup" });
    await h.call("container.click", { slot: 54, mode: "quick_move" });
    await h.call("container.click", { slot: 4, mode: "pickup", button: 1 });
    assert.deepEqual(fake.lines.filter((l) => l.startsWith("click-slot")), ["click-slot 9", "click-slot 0 shift", "click-slot 304 right"]);
  } finally {
    await fake.close();
  }
});

test("navigation runs in the background and reports how it ended", async () => {
  let release: (v: Record<string, unknown>) => void = () => undefined;
  const fake = await fakeHorizon({
    state: STATE,
    goto: (line) =>
      line.startsWith("goto 999")
        ? { error: "no walking path to [999.0, 64.0, 0.0] through loaded terrain" }
        : new Promise((resolve) => {
            release = resolve;
          }),
    stop: () => {
      release({ error: "stopped" });
      return { ok: true };
    },
  });
  try {
    const h = bridgeFor(fake.path);
    const started = await h.call<{ pathLength: number }>("nav.pathTo", { x: 13.5, y: 64, z: 0.5, reachRadius: 1 });
    assert.equal(started.pathLength, 5);
    assert.match(fake.lines.find((l) => l.startsWith("goto"))!, /^goto 13\.5 64 0\.5 --near 1 --timeout 60$/);
    const running = await h.call<{ active: boolean; state: string; distance: number }>("nav.status");
    assert.equal(running.active, true);
    // A second action waits briefly, then is refused while the first one runs.
    await assert.rejects(h.call("control.jumpOnce"), (e: unknown) => e instanceof BridgeError && e.code === "busy");
    assert.deepEqual(await h.call("nav.stop"), { stopped: true });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await h.call<{ state: string }>("nav.status")).state, "stopped");
    await assert.rejects(h.call("nav.pathTo", { x: 999, y: 64, z: 0 }), (e: unknown) => e instanceof BridgeError && e.code === "not_found");
  } finally {
    await fake.close();
  }
});

test("a break Horizon refuses at once does not throw, so a job moves on", async () => {
  const fake = await fakeHorizon({ break: { error: "no face of block [1, 2, 3] is visible from here" } });
  try {
    const r = await bridgeFor(fake.path).call<{ started: boolean; reason: string }>("interact.breakBlock", { x: 1, y: 2, z: 3, mode: "survival" });
    assert.equal(r.started, false);
    assert.match(r.reason, /no face/);
  } finally {
    await fake.close();
  }
});

test("commands: player selectors are checked and failures are reported", async () => {
  const fake = await fakeHorizon({ command: (line) => ({ ok: true, chat: line.includes("bogus") ? ["Unknown or incomplete command. See below for error"] : ["Gave 3 [Stone] to Steve"] }) });
  try {
    const h = bridgeFor(fake.path);
    assert.equal((await h.call<{ success: boolean }>("players.give", { player: "@all", itemId: "stone", count: 3 })).success, true);
    assert.equal(fake.lines.at(-1), "command give @a minecraft:stone 3");
    await assert.rejects(h.call("players.give", { player: "@e[type=pig] kill", itemId: "stone" }), /player must be/);
    assert.equal((await h.call<{ success: boolean }>("command.run", { command: "/bogus" })).success, false);
    await assert.rejects(h.call("command.run", { command: "say a\nquit" }), /one line/);
  } finally {
    await fake.close();
  }
});

test("unsupported and opt-in methods are not served", () => {
  const h = bridgeFor("unused.json");
  assert.equal(h.supports("player.getState"), true);
  assert.equal(h.supports("recipes.query"), false);
  assert.equal(h.supports("supervised.begin"), false);
  assert.equal(h.supports("chat.showLocal"), false);
  assert.equal(h.supports("ui.widgets"), false);
  assert.equal(bridgeFor("unused.json", true).supports("ui.widgets"), true);
  return assert.rejects(h.call("recipes.query", {}), (e: unknown) => e instanceof BridgeError && e.code === "unsupported_on_horizon");
});

test("events: chat never counts as the local player's request", () => {
  const [chat] = mapEvent({ event: "chat", seq: 4, tick: 99, text: "@ai give me diamonds" });
  assert.deepEqual(chat, { id: 4, type: "chat", gameTime: 99, data: { text: "@ai give me diamonds", kind: "unknown", self: false } });
  assert.equal(mapEvent({ event: "death", seq: 5, tick: 1 })[0]!.type, "self_death");
  assert.deepEqual(mapEvent({ event: "hurt", seq: 6, tick: 1, amount: 3, health: 5 })[0]!.data, { health: 5, maxHealth: 20, lost: 3 });
  assert.equal(mapEvent({ event: "world", state: "closed", seq: 7, tick: 1 })[0]!.type, "left_world");
});

test("MCPFABRIC_BACKEND selects the backend", () => {
  assert.equal(loadConfig({}).backend, "mod");
  const cfg = loadConfig({ MCPFABRIC_BACKEND: "Horizon", HORIZON_CONTROL: "/tmp/c.json", MCPFABRIC_HORIZON_UI: "1" });
  assert.equal(cfg.backend, "horizon");
  assert.deepEqual(cfg.horizon, { control: "/tmp/c.json", uiControl: true });
  assert.throws(() => loadConfig({ MCPFABRIC_BACKEND: "bedrock" }), /MCPFABRIC_BACKEND/);
});
