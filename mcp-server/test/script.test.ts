import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import { AgentRuntime } from "../src/agent/runtime.js";
import { AGENT_TOOLS, AgentSession } from "../src/agent/tools.js";
import { runScript, type ScriptHostApi } from "../src/script/sandbox.js";
import { SCRIPT_TOOLS, ScriptHost } from "../src/script/tools.js";
import { FakeWorld } from "./fake-world.js";

const OWNER = "session-a";

function setup(world = new FakeWorld(), limits = {}) {
  const rt = new AgentRuntime(world, { dbPath: ":memory:" });
  const host = new ScriptHost(world, rt, limits);
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const def = SCRIPT_TOOLS.find((t) => t.name === name);
    if (!def) throw new Error(`no tool ${name}`);
    // Parse like the MCP SDK does, so schema defaults apply and invalid schemas fail the test.
    return def.run(host, OWNER, z.object(def.inputSchema).parse(args));
  };
  return { world, rt, host, tool };
}

type Harness = ReturnType<typeof setup>;

/** Every script tool by name, run against the fake world. A new tool fails the first test until it is added here. */
const SCRIPT_TOOL_CASES: Record<string, (h: Harness) => Promise<void>> = {
  run_script: async ({ world, tool }) => {
    const out = await tool("run_script", {
      code: "const me = await mc.get_self();\nmc.log('at', me.x, me.z);\nconst again = await mc.call('player.getState');\nreturn { y: me.y, same: again.y === me.y, n: mc.args.n };",
      args: { n: 3 },
    });
    assert.equal(out.isError, false);
    assert.match(out.text, /^script ok · 2 calls · [\d.]+ s$/m);
    assert.match(out.text, /result: \{"y":64,"same":true,"n":3\}/);
    assert.match(out.text, /log \(1 line\):\n {2}at 0\.5 0\.5/);
    assert.deepEqual(world.calls, ["player.getState", "player.getState"]);
  },
  save_skill: async ({ rt, tool }) => {
    const bad = await tool("save_skill", { name: "broken", description: "x", code: "return (" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /^not saved: SyntaxError/);
    assert.equal((await tool("save_skill", { name: "where_am_i", description: "Position", code: "return (await mc.get_self()).y" })).text, "saved skill where_am_i (30 chars)");
    assert.match((await tool("save_skill", { name: "where_am_i", description: "Position, again", code: "return 1" })).text, /^replaced skill where_am_i/);
    assert.equal(rt.skills.get("sp:test", "where_am_i")!.description, "Position, again");
    assert.equal(rt.skills.get("sp:test", "broken"), undefined);
  },
  list_skills: async ({ tool }) => {
    assert.match((await tool("list_skills")).text, /^no skills yet/);
    await tool("save_skill", { name: "dig", description: "Dig at args.x y z", code: "return mc.args" });
    assert.equal((await tool("list_skills")).text, "# skills · 1\ndig — Dig at args.x y z · never run");
    assert.equal((await tool("list_skills", { name: "dig" })).text, "dig — Dig at args.x y z · never run\n---\nreturn mc.args");
    assert.equal((await tool("list_skills", { name: "nope" })).isError, true);
  },
  run_skill: async ({ rt, tool }) => {
    await tool("save_skill", { name: "height", description: "y + args.add", code: "return (await mc.get_self()).y + mc.args.add" });
    const out = await tool("run_skill", { name: "height", args: { add: 2 } });
    assert.equal(out.isError, false);
    assert.match(out.text, /^skill height ok · 1 call/);
    assert.match(out.text, /result: 66/);
    await tool("save_skill", { name: "fails", description: "throws", code: "throw new Error('no')" });
    const failed = await tool("run_skill", { name: "fails" });
    assert.equal(failed.isError, true);
    assert.match(failed.text, /error: Error: no/);
    assert.match((await tool("list_skills")).text, /height — y \+ args.add · 1 run, last ok/);
    assert.equal(rt.skills.get("sp:test", "fails")!.lastOk, false);
    assert.equal((await tool("run_skill", { name: "missing" })).isError, true);
  },
  delete_skill: async ({ rt, tool }) => {
    await tool("save_skill", { name: "tmp", description: "x", code: "return 1" });
    assert.equal((await tool("delete_skill", { name: "tmp" })).text, "deleted skill tmp");
    assert.equal((await tool("delete_skill", { name: "tmp" })).isError, true);
    assert.equal(rt.skills.list("sp:test").length, 0);
  },
};

test("the script tool table covers exactly SCRIPT_TOOLS", () => {
  assert.deepEqual(Object.keys(SCRIPT_TOOL_CASES).sort(), SCRIPT_TOOLS.map((t) => t.name).sort());
});

for (const [name, run] of Object.entries(SCRIPT_TOOL_CASES)) {
  test(`script tool ${name}`, async () => {
    const h = setup();
    try {
      await run(h);
    } finally {
      h.rt.close();
    }
  });
}

test("skills are kept per world and agent_brief lists them", async () => {
  const h = setup();
  try {
    await h.tool("save_skill", { name: "mine_vein", description: "Mine a vein", code: "return 1" });
    const brief = await AGENT_TOOLS.find((t) => t.name === "agent_brief")!.run(h.rt, new AgentSession(), {});
    assert.match(brief, /^skills \(run_skill\): mine_vein$/m);
    h.world.worldId = "sp:other";
    h.rt.resetWorld();
    assert.match((await h.tool("list_skills")).text, /^no skills yet/);
  } finally {
    h.rt.close();
  }
});

test("only catalogue methods reach the bridge; supervised and unknown methods are refused", async () => {
  const h = setup();
  try {
    const out = await h.tool("run_script", {
      code: `
        const tries = {};
        for (const m of ["supervised.status", "supervised_set_block", "supervised.begin", "perception.scan", "session.info", "no.such"]) {
          try { await mc.call(m); tries[m] = "allowed"; } catch (e) { tries[m] = e.code; }
        }
        try { await mc.get_block({ x: 1, y: 64 }); } catch (e) { tries.invalid = e.code + ": " + e.message; }
        try { await mc.get_block({ x: 1, y: 64, z: 2 }); } catch (e) { tries.bridge = e.name + " " + e.code; }
        try { await mc.call("get_self", [1]); } catch (e) { tries.array = e.code; }
        return tries;`,
    });
    const tries = JSON.parse(/result: (.*)/.exec(out.text)![1]!);
    assert.deepEqual(tries, {
      "supervised.status": "forbidden",
      supervised_set_block: "forbidden",
      "supervised.begin": "forbidden",
      // Methods the agent runtime calls itself are not in the tool catalogue.
      "perception.scan": "unknown_method",
      "session.info": "unknown_method",
      "no.such": "unknown_method",
      invalid: "invalid_params: invalid parameters for get_block: z: Invalid input: expected number, received undefined",
      bridge: "BridgeError unknown_method",
      array: "invalid_params",
    });
    assert.equal((await h.host.run("return typeof mc.supervised_status", { owner: OWNER })).result, '"undefined"');
    // Only the one valid get_block reached the (fake) bridge.
    assert.deepEqual(h.world.calls, ["world.getBlock"]);
  } finally {
    h.rt.close();
  }
});

test("a script sees no Node, file system, network or timers", async () => {
  const h = setup();
  try {
    const ok = await h.host.run(
      `return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof setInterval, typeof XMLHttpRequest, typeof WebAssembly, typeof globalThis.call, typeof globalThis.sleep, typeof globalThis.log]`,
      { owner: OWNER },
    );
    assert.deepEqual(JSON.parse(ok.result!), Array(10).fill("undefined"));
    const imp = await h.host.run(`return await import("node:fs")`, { owner: OWNER });
    assert.equal(imp.ok, false);
    const frozen = await h.host.run(`mc.call = () => 1; return (await mc.call("get_self")).y === 64`, { owner: OWNER });
    assert.equal(frozen.result, "true", "mc is frozen");
  } finally {
    h.rt.close();
  }
});

const api = (calls: string[] = []): ScriptHostApi => ({
  helpers: ["ping"],
  call: async (name) => {
    calls.push(name);
    return { pong: true };
  },
});

test("the time limit interrupts an infinite loop", async () => {
  const run = await runScript("while (true) {}", api(), { limits: { timeoutMs: 300 } });
  assert.equal(run.ok, false);
  assert.equal(run.stopped, "timeout");
  assert.match(run.error!.message, /time limit \(0.3 s\)/);
  assert.ok(run.durationMs < 2000, `took ${run.durationMs} ms`);
});

test("a long computation without awaiting is stopped even within the time limit", async () => {
  const run = await runScript("await mc.ping(); for (;;) {}", api(), { limits: { timeoutMs: 10_000, maxSliceMs: 200 } });
  assert.equal(run.stopped, "cpu");
  assert.equal(run.calls, 1);
});

test("no bridge call happens after the time limit", async () => {
  const calls: string[] = [];
  const run = await runScript("for (;;) { try { await mc.ping(); } catch (e) {} await mc.sleep(10); }", api(calls), { limits: { timeoutMs: 300 } });
  assert.equal(run.stopped, "timeout");
  const n = calls.length;
  assert.ok(n > 0);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(calls.length, n);
});

test("the memory limit stops a script", async () => {
  const run = await runScript("const a = []; for (;;) a.push(new ArrayBuffer(4 << 20));", api(), { limits: { memoryBytes: 16 << 20 } });
  assert.equal(run.ok, false);
  assert.equal(run.stopped, "memory");
});

test("the call limit stops a script", async () => {
  const calls: string[] = [];
  const run = await runScript("for (let i = 0; i < 100; i++) await mc.ping(); return 'done'", api(calls), { limits: { maxCalls: 5 } });
  assert.equal(run.stopped, "call_limit");
  assert.equal(run.calls, 5);
  assert.equal(calls.length, 5);
});

test("logs are captured and capped; the result is the returned JSON", async () => {
  const run = await runScript("console.log('a', 1, [2]); mc.log({ b: true }); for (let i = 0; i < 100; i++) mc.log('x'.repeat(10)); return { ok: 1 }", api(), {
    limits: { maxLogChars: 100 },
  });
  assert.equal(run.ok, true);
  assert.equal(run.result, '{"ok":1}');
  assert.deepEqual(run.logs.slice(0, 2), ["a 1 [2]", '{"b":true}']);
  assert.equal(run.logTruncated, true);
  assert.ok(run.logs.join("\n").length <= 110);
});

test("errors come back with their stack; parallel calls and sleep work", async () => {
  const run = await runScript("const r = await Promise.all([mc.ping(), mc.call('ping')]);\nawait mc.sleep(5);\nthrow new RangeError('bad ' + r.length);", api());
  assert.equal(run.ok, false);
  assert.equal(run.calls, 2);
  assert.deepEqual([run.error!.name, run.error!.message], ["RangeError", "bad 2"]);
  assert.match(run.error!.stack!, /script\.js:3/);
  const never = await runScript("await new Promise(() => {})", api());
  assert.match(never.error!.message, /nothing will settle/);
});

test("a script and a job never run at the same time", async () => {
  const h = setup();
  try {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.rt.jobs.start("wait", "hold the body", async () => {
      await gate;
      return "done";
    }, OWNER);
    await assert.rejects(h.host.run("return 1", { owner: OWNER }), /Job #1 \(wait\) is running/);
    release();
    await h.rt.jobs.wait(undefined, 1000);

    const running = h.host.run("await mc.sleep(300); return 1", { owner: OWNER });
    await new Promise((r) => setTimeout(r, 50));
    assert.throws(() => h.rt.jobs.start("other", "x", async () => "y"), /A script is running/);
    await assert.rejects(h.host.run("return 2", { owner: "session-b" }), /another MCP session is running a script/);
    assert.equal((await running).ok, true);
    // Released afterwards.
    const job = h.rt.jobs.start("after", "x", async () => "y");
    await h.rt.jobs.wait(job.id, 1000);
  } finally {
    h.rt.close();
  }
});

test("closing the session stops its script and releases the body", async () => {
  const h = setup();
  try {
    const running = h.host.run("for (;;) { await mc.get_self(); await mc.sleep(20); }", { owner: OWNER });
    await new Promise((r) => setTimeout(r, 100));
    h.host.cancelOwnedBy("someone-else");
    h.host.cancelOwnedBy(OWNER);
    const run = await running;
    assert.equal(run.stopped, "cancelled");
    assert.deepEqual(h.world.calls.slice(-3), ["control.stop", "nav.stop", "interact.stopBreaking"]);
  } finally {
    h.rt.close();
  }
});

test("run_script works without the agent runtime; the skill tools need it", async () => {
  const world = new FakeWorld();
  const host = new ScriptHost(world);
  const run = await host.run("return (await mc.get_self()).y", { owner: OWNER });
  assert.equal(run.result, "64");
  const save = SCRIPT_TOOLS.find((t) => t.name === "save_skill")!;
  assert.ok(save.needsRuntime);
  await assert.rejects(save.run(host, OWNER, { name: "a", description: "b", code: "return 1" }), /need the agent runtime/);
});
