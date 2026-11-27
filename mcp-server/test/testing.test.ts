import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Bridge } from "../src/agent/body.js";
import { BridgeError, type BridgeEvent } from "../src/bridge.js";
import { ScriptHost } from "../src/script/tools.js";
import { main, parseArgs } from "../src/testing/cli.js";
import { draftTest, type RecordedStep } from "../src/testing/draft.js";
import { withDraft } from "../src/tools.js";
import { formatResult, junit, xml } from "../src/testing/report.js";
import { findTestFiles, slug, TestRunner, type RunOptions, type TestResult } from "../src/testing/runner.js";

/** Just enough of the bridge for the test runner: events, chat, commands, a screen and a player. */
/** A recording as the mod returns it: the player walks, mines, places, loots a chest and chats. */
const RECORDED: RecordedStep[] = [
  { kind: "start", t: 0, x: 0, y: 64, z: 0, dimension: "minecraft:overworld", slot: 0, held: "minecraft:dirt", inventory: { "minecraft:dirt": 5 } },
  { kind: "move", t: 900, x: 3, y: 64, z: 0 },
  { kind: "move", t: 1800, x: 6, y: 64, z: 1 },
  { kind: "break", t: 2500, x: 7, y: 64, z: 1, block: "minecraft:stone" },
  { kind: "select", t: 3000, slot: 1, item: "minecraft:torch" },
  { kind: "place", t: 3200, x: 7, y: 64, z: 2, state: "minecraft:wall_torch[facing=south]", item: "minecraft:torch" },
  { kind: "use_block", t: 3600, x: 8, y: 64, z: 2, from: "minecraft:lever[powered=false]", to: "minecraft:lever[powered=true]" },
  { kind: "attack", t: 3900, type: "minecraft:zombie", uuid: "u", x: 9, y: 64, z: 3 },
  { kind: "open_container", t: 4000, x: 8, y: 64, z: 1, block: "minecraft:chest" },
  { kind: "close_container", t: 6000, inventoryChange: { "minecraft:diamond": 2, "minecraft:dirt": -5 } },
  { kind: "chat", t: 7000, message: 'got "two"\n*/ diamonds' },
  { kind: "end", t: 7100, x: 8, y: 64, z: 2, inventory: { "minecraft:diamond": 2 } },
];

class FakeGame implements Bridge {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  events: BridgeEvent[] = [];
  health = 20;
  screen: Record<string, unknown> = { inWorld: true, screen: "none", paused: false, canJoin: false };
  navTarget: Record<string, unknown> | undefined;
  private seq = 0;
  private timers: NodeJS.Timeout[] = [];

  emit(type: string, data: Record<string, unknown>): void {
    this.seq++;
    this.events.push({ id: this.seq, type, gameTime: this.seq, data });
  }

  later(ms: number, fn: () => void): void {
    const t = setTimeout(fn, ms);
    t.unref();
    this.timers.push(t);
  }

  commands(): string[] {
    return this.calls.filter((c) => c.method === "command.run").map((c) => String(c.params.command));
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    const r = (v: unknown) => v as T;
    switch (method) {
      case "session.info":
        return r({ worldId: "sp:test", kind: "singleplayer", player: "Dev", dimension: "minecraft:overworld" });
      case "events.getRecent": {
        const since = typeof params.sinceId === "number" ? params.sinceId : 0;
        const types = Array.isArray(params.types) ? (params.types as string[]) : [];
        const limit = typeof params.limit === "number" ? params.limit : 50;
        const picked = this.events.filter((e) => e.id > since && (types.length === 0 || types.includes(e.type))).slice(-limit);
        return r({ events: picked, lastId: this.seq });
      }
      case "command.run": {
        const cmd = String(params.command);
        if (cmd.startsWith("fail")) return r({ command: cmd, success: false, resultValue: 0, output: ["Unknown or incomplete command"] });
        if (cmd.startsWith("say ")) {
          const text = `[Server] ${cmd.slice(4)}`;
          // An integrated server reports the line once on the server and once on the client.
          this.later(30, () => {
            this.emit("chat", { player: "Server", text });
            this.emit("system_message", { text, overlay: false });
          });
        }
        if (cmd === "heal") for (let i = 1; i <= 10; i++) this.later(i * 20, () => (this.health += 1));
        if (cmd === "open") this.later(50, () => (this.screen = { ...this.screen, screen: "container" }));
        return r({ command: cmd, success: true, resultValue: 1, output: [] });
      }
      case "screen.get":
        return r(this.screen);
      case "player.getState":
        return r({ x: 0.5, y: 64, z: 0.5, health: this.health });
      case "player.getInventory":
        return r({ selectedSlot: 0, hotbar: [{ slot: 0, id: "minecraft:dirt", count: 3 }], main: [{ slot: 9, id: "minecraft:dirt", count: 2 }] });
      case "vision.screenshot":
        return r({ format: "png", width: 1, height: 1, bytes: 7, base64: Buffer.from("PNGDATA").toString("base64") });
      case "container.state":
        return r({ open: true, containerId: 3, type: "minecraft:generic_9x3", title: "Shop", size: 27, slots: [{ slot: 4, id: "minecraft:diamond_sword", count: 1 }] });
      case "container.click":
        return r({ open: true, clicked: params.slot });
      case "control.stop":
      case "nav.stop":
      case "interact.stopBreaking":
        return r({ ok: true });
      case "nav.pathTo":
        this.navTarget = params;
        return r({ ok: true });
      case "nav.status":
        return r({ active: false, state: this.navTarget && this.navTarget.x === 99 ? "stuck" : "reached" });
      case "inventory.selectHotbar":
      case "interact.breakBlock":
      case "interact.placeAt":
      case "interact.useItem":
      case "control.lookAt":
      case "container.open":
        this.screen = { ...this.screen, screen: "container" };
        return r({ ok: true });
      case "container.close":
        this.screen = { ...this.screen, screen: "none" };
        return r({ ok: true });
      case "chat.send":
        return r({ ok: true });
      case "recorder.start":
        return r({ recording: true, count: 0 });
      case "recorder.stop":
        return r({ recording: false, count: RECORDED.length, stoppedBy: "stopped", steps: RECORDED });
      default:
        throw new BridgeError({ code: "unknown_method", message: `unknown method ${method}` });
    }
  }
}

function dir(): string {
  return mkdtempSync(join(tmpdir(), "mctest-"));
}

function file(d: string, name: string, code: string): string {
  const p = join(d, name);
  writeFileSync(p, code);
  return p;
}

async function run(code: string, opts: RunOptions = {}, game = new FakeGame()): Promise<{ results: TestResult[]; game: FakeGame; d: string }> {
  const d = dir();
  const p = file(d, "case.mctest.js", code);
  const results = await new TestRunner(game, opts).run([p]);
  return { results, game, d };
}

const byName = (results: TestResult[], name: string) => {
  const r = results.find((x) => x.name === name);
  assert.ok(r, `no result for ${name}: ${results.map((x) => x.name).join(", ")}`);
  return r;
};
const lastError = (r: TestResult) => r.attempts[r.attempts.length - 1]?.error;

test("lists the tests of a file without calling the game", async () => {
  const game = new FakeGame();
  const d = dir();
  const p = file(d, "list.mctest.js", 'test("a", async () => {});\ntest.skip("b");\ntest("c", async () => {}, { timeout: 5000 });\n');
  const listed = await new TestRunner(game).list(p);
  assert.deepEqual(
    listed.tests.map((t) => [t.name, t.skip, t.timeoutMs]),
    [
      ["a", false, 30000],
      ["b", true, 30000],
      ["c", false, 5000],
    ],
  );
  assert.equal(game.calls.length, 0);
});

test("a call at the top level of a file fails the file, a syntax error too", async () => {
  const top = await run('await mc.get_self();\ntest("a", async () => {});');
  assert.equal(top.results.length, 1);
  assert.equal(top.results[0]!.name, "(load)");
  assert.match(lastError(top.results[0]!)!.message, /only be called inside test\(\)/);
  assert.equal(top.game.calls.length, 0);

  const syntax = await run('test("a", async () => {\n');
  assert.equal(syntax.results[0]!.status, "failed");
  assert.equal(lastError(syntax.results[0]!)!.name, "SyntaxError");

  const ret = await run('test("a", async () => {});\nreturn 1;');
  assert.match(lastError(ret.results[0]!)!.message, /did not hand control back/);
});

test("passing and failing tests, with assertion messages and the failing step", async () => {
  const { results } = await run(`
test("passes", async () => {
  const me = await mc.get_self();
  expect(me.health).toBe(20);
  expect({ a: [1, { b: 2 }] }).toEqual({ a: [1, { b: 2 }] });
  expect([1, 2, 3]).toContain(2);
  expect("diamond sword").toMatch(/sword$/);
  expect(me).toHaveProperty("health", 20);
  expect(0.1 + 0.2).toBeCloseTo(0.3);
  expect(me.health).not.toBeLessThan(10);
  assert.equal(await inventoryCount("dirt"), 5);
});
test("fails in a step", async () => {
  await step("outer", async () => {
    await step("inner", async () => {
      expect(1 + 2, "sum").toBe(4);
    });
  });
});
test("throws", async () => { null.x; });
`);
  assert.equal(byName(results, "passes").status, "passed");
  const failed = byName(results, "fails in a step");
  assert.equal(failed.status, "failed");
  const e = lastError(failed)!;
  assert.equal(e.name, "AssertionError");
  assert.equal(e.message, "sum: expected 3 to be 4");
  assert.equal(e.step, "outer > inner");
  assert.equal(e.phase, "test");
  assert.deepEqual(
    failed.attempts[0]!.steps.map((s) => [s.name, s.depth, s.status]),
    [
      ["outer", 0, "failed"],
      ["inner", 1, "failed"],
    ],
  );
  assert.equal(lastError(byName(results, "throws"))!.name, "TypeError");
  // The frame in the test file is shown with its line.
  assert.ok(formatResult(byName(results, "throws")).some((l) => /test file:\d+/.test(l)));
});

test("waitForChat matches lines that arrive after the test started, each line once", async () => {
  const game = new FakeGame();
  game.emit("system_message", { text: "[Server] hello" }); // before the test: ignored
  const { results } = await run(
    `
test("chat", async () => {
  await command("say hello");
  const line = await waitForChat("hello", { timeout: 2000 });
  expect(line.text).toBe("[Server] hello");
  let err;
  try { await waitForChat(/hello/, { timeout: 300 }); } catch (e) { err = e; }
  expect(err && err.name).toBe("TimeoutError");
  expect(err.message).toMatch("timed out after 300 ms");
});
test("ordered", async () => {
  await command("say one");
  await command("say two");
  await waitForChat("one", { timeout: 2000 });
  await waitForChat("two", { timeout: 2000 });
});
`,
    {},
    game,
  );
  assert.equal(byName(results, "chat").status, "passed", JSON.stringify(lastError(byName(results, "chat"))));
  assert.equal(byName(results, "ordered").status, "passed", JSON.stringify(lastError(byName(results, "ordered"))));
});

test("expect.poll, waitFor, waitForScreen and waitForEvent wait for the game", async () => {
  const { results } = await run(`
test("poll", async () => {
  await command("heal");
  const h = await expect.poll(async () => (await mc.get_self()).health, { timeout: 2000 }).toBeGreaterThan(25);
  expect(h).toBeGreaterThan(25);
});
test("screen", async () => {
  await command("open");
  const s = await waitForScreen("container", { timeout: 2000 });
  expect(s.screen).toBe("container");
});
test("event", async () => {
  await command("say boom");
  const e = await waitForEvent("chat", { where: (ev) => ev.data.text.includes("boom"), timeout: 2000 });
  expect(e.type).toBe("chat");
});
test("poll fails with the last value", async () => {
  await expect.poll(async () => 7, { timeout: 200 }).toBe(8);
});
test("waitFor fails with the last error", async () => {
  await waitFor(async () => { throw new Error("not yet"); }, { timeout: 200, message: "door opens" });
});
`);
  for (const name of ["poll", "screen", "event"]) assert.equal(byName(results, name).status, "passed", `${name}: ${JSON.stringify(lastError(byName(results, name)))}`);
  assert.match(lastError(byName(results, "poll fails with the last value"))!.message, /^expected 7 to be 8 \(polled \d+ times for 200 ms\)$/);
  const w = lastError(byName(results, "waitFor fails with the last error"))!;
  assert.equal(w.name, "TimeoutError");
  assert.match(w.message, /^door opens timed out after 200 ms \(\d+ tries\), last error: Error: not yet$/);
});

test("a test over its time limit still gets its afterEach, and the body is released", async () => {
  const { results, game } = await run(`
beforeEach(async () => { await command("setup"); });
afterEach(async () => { await command("cleanup"); });
test("slow", async () => { await sleep(10000); }, { timeout: 200 });
`);
  const r = byName(results, "slow");
  assert.equal(r.status, "failed");
  assert.equal(lastError(r)!.name, "TimeoutError");
  assert.equal(lastError(r)!.message, "test timed out after 200 ms");
  assert.deepEqual(game.commands(), ["setup", "cleanup"]);
  assert.ok(game.calls.some((c) => c.method === "control.stop"));
});

test("a failing command is an error with the game's output; afterEach failures are reported", async () => {
  const { results } = await run(`
test("bad command", async () => { await command("fail now"); });
`);
  assert.equal(lastError(byName(results, "bad command"))!.message, "command failed: /fail now: Unknown or incomplete command");

  const after = await run(`
afterEach(async () => { throw new Error("cleanup broke"); });
test("ok body", async () => {});
`);
  const e = lastError(byName(after.results, "ok body"))!;
  assert.equal(e.phase, "afterEach");
  assert.equal(e.message, "cleanup broke");
});

test("beforeAll and afterAll run once per file; a failed beforeAll fails its tests", async () => {
  const ok = await run(`
beforeAll(async () => { await command("world setup"); });
afterAll(async () => { await command("world teardown"); });
test("one", async () => { await command("one"); });
test("two", async () => { await command("two"); });
`);
  assert.deepEqual(ok.game.commands(), ["world setup", "one", "two", "world teardown"]);

  const bad = await run(`
beforeAll(async () => { await command("fail setup"); });
afterAll(async () => { await command("teardown"); });
test("one", async () => { await command("one"); });
`);
  const r = byName(bad.results, "one");
  assert.equal(r.status, "failed");
  assert.match(lastError(r)!.message, /^beforeAll failed: command failed/);
  assert.deepEqual(bad.game.commands(), ["fail setup", "teardown"]);
});

test("retries mark a test that passes later as flaky and keep the failed attempt's screenshot and context", async () => {
  const d = dir();
  const artifactsDir = join(d, "out");
  const { results } = await run(
    `
test("Flaky / one!", async (t) => {
  mc.log("attempt", t.attempt);
  expect(t.attempt).toBe(2);
});
`,
    { retries: 2, artifactsDir },
  );
  const r = byName(results, "Flaky / one!");
  assert.equal(r.status, "passed");
  assert.equal(r.flaky, true);
  assert.equal(r.attempts.length, 2);
  assert.deepEqual(r.attempts.map((a) => a.logs), [["attempt 1"], ["attempt 2"]]);
  const kept = r.attempts[0]!.artifacts;
  assert.equal(kept.length, 2);
  const shot = kept.find((p) => p.endsWith("screenshot.png"))!;
  assert.match(shot.replaceAll("\\", "/"), /\/01-flaky-one\/screenshot\.png$/);
  assert.equal(readFileSync(shot, "utf8"), "PNGDATA");
  const ctx = JSON.parse(readFileSync(kept.find((p) => p.endsWith("context.json"))!, "utf8"));
  assert.equal(ctx.test, "Flaky / one!");
  assert.equal(ctx.error.message, "expected 1 to be 2");
  assert.equal(ctx.player.health, 20);
  assert.deepEqual(ctx.logs, ["attempt 1"]);
  assert.deepEqual(r.attempts[1]!.artifacts, []);
});

test("test.only, test.skip, --grep and --bail pick what runs", async () => {
  const only = await run('test("a", async () => {});\ntest.only("b", async () => {});\ntest.skip("c");');
  assert.deepEqual(
    only.results.map((r) => [r.name, r.status]),
    [
      ["a", "skipped"],
      ["b", "passed"],
      ["c", "skipped"],
    ],
  );

  const grep = await run('test("alpha", async () => {});\ntest("beta", async () => {});', { grep: /beta/ });
  assert.deepEqual(grep.results.map((r) => r.name), ["beta"]);

  const bail = await run('test("a", async () => { assert.fail("no"); });\ntest("b", async () => { await command("b"); });', { bail: true });
  assert.deepEqual(
    bail.results.map((r) => [r.name, r.status]),
    [
      ["a", "failed"],
      ["b", "skipped"],
    ],
  );
  assert.deepEqual(bail.game.commands(), []);
});

test("params reach the file", async () => {
  const { results } = await run('test("p", async () => { expect(params.server).toBe("lobby"); expect(Object.isFrozen(params)).toBe(true); });', {
    params: { server: "lobby" },
  });
  assert.equal(byName(results, "p").status, "passed");
});

test("JUnit XML escapes text, links artifacts and lists flaky attempts", () => {
  const results: TestResult[] = [
    {
      file: "mctest/a.mctest.js",
      name: 'menu <opens> & "closes"',
      status: "failed",
      flaky: false,
      durationMs: 1500,
      attempts: [
        {
          attempt: 1,
          ok: false,
          durationMs: 1500,
          steps: [],
          logs: ["line\u0001with control"],
          artifacts: ["mctest-results/a/01-menu/screenshot.png"],
          error: { name: "AssertionError", message: "expected <a> to be 'b'", phase: "test", step: "open" },
        },
      ],
    },
    {
      file: "mctest/a.mctest.js",
      name: "flaky",
      status: "passed",
      flaky: true,
      durationMs: 10,
      attempts: [
        { attempt: 1, ok: false, durationMs: 5, steps: [], logs: [], artifacts: [], error: { name: "Error", message: "first", phase: "test" } },
        { attempt: 2, ok: true, durationMs: 5, steps: [], logs: [], artifacts: [] },
      ],
    },
    { file: "mctest/b.mctest.js", name: "later", status: "skipped", flaky: false, skipReason: "test.skip", durationMs: 0, attempts: [] },
  ];
  const out = junit(results, 2000, new Date("2026-11-27T10:00:00Z"));
  assert.match(out, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<testsuites name="mcpfabric" tests="3" failures="1" errors="0" skipped="1" time="2.000">/);
  assert.match(out, /<testsuite name="mctest\/a.mctest.js" tests="2" failures="1" errors="0" skipped="0" time="1.510" timestamp="2026-11-27T10:00:00">/);
  assert.match(out, /<testcase classname="mctest\/a.mctest.js" name="menu &lt;opens&gt; &amp; &quot;closes&quot;" time="1.500">/);
  assert.match(out, /<failure message="expected &lt;a&gt; to be &apos;b&apos;" type="AssertionError">AssertionError: expected &lt;a&gt; to be &apos;b&apos;\nat step: open<\/failure>/);
  assert.match(out, /<system-out>linewith control\n\[\[ATTACHMENT\|mctest-results\/a\/01-menu\/screenshot.png\]\]<\/system-out>/);
  assert.match(out, /<flakyFailure message="first" type="Error">/);
  assert.match(out, /<skipped message="test.skip"\/>/);
  assert.equal(xml("a\u0000b\uFFFEc"), "abc");
});

test("findTestFiles searches directories for *.mctest.js and skips node_modules", () => {
  const d = dir();
  mkdirSync(join(d, "sub"));
  mkdirSync(join(d, "node_modules"));
  file(d, "a.mctest.js", "");
  file(join(d, "sub"), "b.mctest.js", "");
  file(join(d, "sub"), "helper.js", "");
  file(join(d, "node_modules"), "c.mctest.js", "");
  assert.deepEqual(
    findTestFiles([d]).map((p) => p.slice(d.length + 1).replaceAll("\\", "/")),
    ["a.mctest.js", "sub/b.mctest.js"],
  );
  assert.equal(slug("Buy a Sword: ok?"), "buy-a-sword-ok");
});

test("the CLI parses its options and exits 1 on a failure with a JUnit report", async () => {
  assert.throws(() => parseArgs(["--retries", "-1"]), /--retries takes a whole number/);
  assert.throws(() => parseArgs(["--param", "nokey"]), /key=value/);
  assert.throws(() => parseArgs(["--frobnicate"]), /unknown option/);
  assert.deepEqual(parseArgs(["a", "--param", "k=v=w", "--no-artifacts"]).params, { k: "v=w" });

  const d = dir();
  file(d, "x.mctest.js", 'test("good", async () => {});\ntest("bad", async () => { expect(1).toBe(2); });');
  const lines: string[] = [];
  const game = new FakeGame();
  const report = join(d, "reports", "junit.xml");
  const code = await main([d, "--junit", report, "--artifacts", join(d, "art"), "--world", "sp:test"], () => game, (l) => lines.push(l));
  assert.equal(code, 1);
  assert.ok(existsSync(report));
  assert.match(readFileSync(report, "utf8"), /failures="1"/);
  assert.ok(lines.some((l) => /^ {2}PASS {2}good/.test(l)));
  assert.ok(lines.some((l) => /^ {2}FAIL {2}bad/.test(l)));
  assert.equal(lines[lines.length - 1], lines.find((l) => /^1 passed, 1 failed \(/.test(l)));

  await assert.rejects(main([d, "--world", "sp:other"], () => game, () => undefined), /not sp:other; refusing/);
  assert.equal(await main([join(d, "reports")], () => game, () => undefined), 2);
  const listed: string[] = [];
  assert.equal(await main([d, "--list"], () => game, (l) => listed.push(l)), 0);
  assert.deepEqual(listed.slice(1), ["  good", "  bad", "2 tests"]);
});

test("the example file loads and names its tests", async () => {
  // Compiled to .test-build/test/, two levels below the package.
  const listed = await new TestRunner(new FakeGame()).list(fileURLToPath(new URL("../../examples/basics.mctest.js", import.meta.url)));
  assert.equal(listed.tests.length, 4);
  assert.equal(listed.hooks.beforeEach, 1);
});

test("tests can work menus through the container methods, run_script cannot", async () => {
  const { results, game } = await run(`
test("shop", async () => {
  const menu = await mc.container_state();
  expect(menu.title).toBe("Shop");
  const sword = menu.slots.find((s) => s.id === "minecraft:diamond_sword");
  await mc.container_click({ slot: sword.slot, mode: "quick_move" });
});
test("bad slot", async () => { await mc.container_click({ slot: -1 }); });
`);
  assert.equal(byName(results, "shop").status, "passed", JSON.stringify(lastError(byName(results, "shop"))));
  assert.deepEqual(game.calls.find((c) => c.method === "container.click")?.params, { slot: 4, mode: "quick_move" });
  assert.match(lastError(byName(results, "bad slot"))!.message, /invalid parameters for container_click/);

  const mcpHost = new ScriptHost(new FakeGame());
  const out = await mcpHost.run("return await mc.call('container.click', { slot: 1 })", { owner: "o" });
  assert.equal(out.ok, false);
  assert.match(out.error!.message, /unknown method "container.click"/);
});

test("a recording becomes a draft test that replays it and checks the inventory", () => {
  const draft = draftTest(RECORDED, { name: "loot the chest" });
  assert.match(draft, /^test\("loot the chest", async \(\) => \{$/m);
  // Waypoints with nothing in between collapse into the last one.
  assert.ok(!draft.includes("goTo({ x: 3, y: 64, z: 0 })"));
  assert.ok(draft.includes("await goTo({ x: 6, y: 64, z: 1 });"));
  assert.ok(draft.includes("await mc.break_block({ x: 7, y: 64, z: 1 }); // minecraft:stone"));
  assert.ok(draft.includes('await mc.place_block_at({ ...{ x: 7, y: 64, z: 2 }, state: "minecraft:wall_torch[facing=south]" });'));
  assert.ok(draft.includes("await mc.look_at({ x: 8.5, y: 64.5, z: 2.5 });"));
  assert.ok(draft.includes("await mc.container_open({ x: 8, y: 64, z: 1 }); // minecraft:chest"));
  assert.ok(draft.includes("// Taken out: 2 minecraft:diamond."));
  assert.ok(draft.includes('expect(await inventoryCount("minecraft:diamond")).toBe(2);'));
  assert.ok(draft.includes('expect(await inventoryCount("minecraft:dirt")).toBe(0);'));
  // Chat text stays inside its string literal.
  assert.ok(draft.includes('await mc.send_chat({ message: "got \\"two\\"\\n*/ diamonds" });'));
  assert.doesNotThrow(() => new Function("test", "mc", draft));
});

test("the draft runs against the game", async () => {
  const { results, game } = await run(draftTest(RECORDED));
  assert.equal(results.length, 1);
  // The fake inventory holds dirt, not diamonds, so the final check is what fails.
  assert.equal(results[0].status, "failed");
  assert.match(String(lastError(results[0])?.message), /inventoryCount|toBe|2/);
  const methods = game.calls.map((c) => c.method);
  for (const m of ["nav.pathTo", "interact.breakBlock", "inventory.selectHotbar", "interact.placeAt", "control.lookAt", "interact.useItem", "container.open", "container.close", "chat.send"]) {
    assert.ok(methods.includes(m), `the draft did not call ${m}`);
  }
});

test("goTo fails when navigation does not reach the target", async () => {
  const { results } = await run(`test("stuck", async () => { await goTo({ x: 99, y: 64, z: 0 }); });`);
  assert.equal(results[0].status, "failed");
  assert.match(String(lastError(results[0])?.message), /goTo\(.*\) ended with "stuck"/);
});

test("stop_recording adds the draft; other answers pass through", () => {
  const out = withDraft({ count: 1, steps: [{ kind: "chat", message: "hi" }] }, "greet") as { draft: string };
  assert.match(out.draft, /test\("greet"/);
  assert.deepEqual(withDraft({ recording: true }), { recording: true });
});

test("mcpfabric-test record writes the draft and will not overwrite a file", async () => {
  const d = dir();
  const out = join(d, "sub", "loot.mctest.js");
  const lines: string[] = [];
  const game = new FakeGame();
  assert.equal(await main(["record", out, "--name", "loot"], () => game, (l) => lines.push(l), async () => undefined), 0);
  assert.deepEqual(game.calls.map((c) => c.method), ["recorder.start", "recorder.stop"]);
  assert.match(readFileSync(out, "utf8"), /test\("loot"/);
  assert.match(lines[lines.length - 1], /^12 steps written to /);
  await assert.rejects(main(["record", out], () => game, () => undefined, async () => undefined), /exists/);
  await assert.rejects(main(["record", join(d, "x.js")], () => game, () => undefined, async () => undefined), /\.mctest\.js/);
});
