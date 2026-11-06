import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import { AgentRuntime } from "../src/agent/runtime.js";
import { AGENT_TOOLS, AgentSession } from "../src/agent/tools.js";
import { FakeWorld, vanillaRecipes } from "./fake-world.js";

function setup(world = new FakeWorld()) {
  world.recipes = vanillaRecipes();
  const rt = new AgentRuntime(world, { dbPath: ":memory:" });
  const session = new AgentSession();
  const tool = (name: string, args: Record<string, unknown> = {}) => {
    const def = AGENT_TOOLS.find((t) => t.name === name);
    if (!def) throw new Error(`no tool ${name}`);
    // Parse like the MCP SDK does, so schema defaults apply and invalid schemas fail the test.
    return def.run(rt, session, z.object(def.inputSchema).parse(args));
  };
  return { world, rt, session, tool };
}

type Harness = ReturnType<typeof setup>;

/** A chest at 2 64 1 holding five raw iron, within reach of the player. */
function withChest(world: FakeWorld): FakeWorld {
  world.set({ x: 2, y: 64, z: 1 }, "minecraft:chest");
  world.containers.set("2,64,1", new Map([[0, { id: "minecraft:raw_iron", count: 5 }]]));
  return world;
}

/**
 * Every agent tool by name, each run against the fake world with a check of its output or effect.
 * A new tool fails the first test until it is added here.
 */
const AGENT_TOOL_CASES: Record<string, (h: Harness) => Promise<void>> = {
  // orientation
  agent_brief: async ({ world, tool }) => {
    world.give("minecraft:oak_log", 3);
    await tool("goal_add", { title: "Build a hut" });
    const brief = await tool("agent_brief");
    assert.match(brief, /^# brief · world sp:test · memory 0 entries · map 0 chunks/);
    assert.match(brief, /inventory: oak_log×3/);
    assert.match(brief, /goal: #1 Build a hut/);
    assert.match(brief, /map: nothing mapped here yet/);
  },
  observe: async ({ world, rt, tool }) => {
    world.set({ x: 3, y: 64, z: 3 }, "minecraft:crafting_table").set({ x: 8, y: 60, z: 8 }, "minecraft:coal_ore");
    const out = await tool("observe", { radius: 1, find: ["coal_ore"] });
    assert.match(out, /9 chunks \(9 new\)/);
    assert.match(out, /new places: #1 crafting table/);
    assert.match(out, /found: coal_ore @ 8 60 8/);
    assert.equal(rt.map.count("sp:test"), 9);
  },
  map_view: async ({ world, tool }) => {
    world.set({ x: 20, y: 64, z: 4 }, "minecraft:chest");
    await tool("observe", { radius: 1 });
    const rows = (await tool("map_view", { radius: 2 })).split("\n");
    assert.match(rows[0]!, /^north ↑ · 1 char = 1 chunk/);
    assert.deepEqual(rows.slice(1, 6), ["?????", "?...?", "?.@C?", "?...?", "?????"], "a 3×3 explored block, the chest one chunk east");
    assert.match(rows[6]!, /C storage/);
  },
  surroundings: async ({ world, tool }) => {
    world.mobs.push({ uuid: "z1", type: "minecraft:zombie", x: 3.5, y: 64, z: 5.5, health: 20 });
    world.set({ x: 0, y: 64, z: -4 }, "minecraft:crafting_table");
    const out = await tool("surroundings", { radius: 16 });
    assert.match(out, /^facing south at 1 64 1 · on ground/);
    assert.match(out, /hostile:\n  zombie 20hp: 5 ahead, 3 left · 5\.8 m \(11 o'clock\) · 4 64 6/);
    assert.match(out, /places:\n  crafting_table: 5 behind, 1 right · 4\.5 m \(6 o'clock\) · 0 64 -4/);
  },
  // memory
  remember: async ({ rt, tool }) => {
    assert.match(await tool("remember", { kind: "place", title: "Home", tags: ["base"] }), /^remembered #1 place "Home" @ 1 64 1 overworld$/);
    assert.match(await tool("remember", { title: "Lava lake", x: 40, y: 12, z: -8 }), /^remembered #2 note "Lava lake" @ 40 12 -8/);
    assert.equal(rt.memory.count("sp:test"), 2);
  },
  recall: async ({ tool }) => {
    await tool("remember", { title: "Village to the east", body: "has a blacksmith" });
    await tool("remember", { title: "Mineshaft entrance" });
    const hits = await tool("recall", { query: "village", fresh: true });
    assert.match(hits, /# recall "village" · 1 hit/);
    assert.match(hits, /#1 note "Village to the east"/);
    assert.doesNotMatch(hits, /Mineshaft/);
    assert.match(await tool("recall", { ids: [2] }), /#2 note "Mineshaft entrance"/);
  },
  memory_update: async ({ rt, tool }) => {
    await tool("remember", { title: "Old note" });
    assert.match(await tool("memory_update", { id: 1, title: "Fixed note", tags: ["base"] }), /^updated #1 note "Fixed note"/);
    assert.equal(rt.memory.get("sp:test", 1)!.title, "Fixed note");
    assert.deepEqual(rt.memory.get("sp:test", 1)!.tags, ["base"]);
    assert.equal(await tool("memory_update", { id: 1, delete: true }), "deleted #1");
    assert.equal(rt.memory.get("sp:test", 1), undefined);
    assert.equal(await tool("memory_update", { id: 9, title: "x" }), "#9 not found");
  },
  memory_verify: async ({ world, tool }) => {
    assert.equal(await tool("memory_verify"), "nothing to verify (no remembered blocks here)");
    withChest(world);
    await tool("observe", { radius: 1 });
    assert.match(await tool("memory_verify"), /1 checked · 0 invalid\n#1 chest @ 2 64 1: valid/);
    world.blocks.delete("2,64,1");
    assert.match(await tool("memory_verify"), /1 invalid\n#1 chest @ 2 64 1: gone \(now air\)/);
  },
  // goals
  goal_add: async ({ rt, tool }) => {
    assert.match(await tool("goal_add", { title: "Iron kit", doneWhen: "iron pickaxe" }), /^added #1 \[pending\] Iron kit\nnext: #1 Iron kit/);
    assert.match(await tool("goal_add", { title: "Mine iron", parent: 1, activate: true }), /^added #2 \[active\] Mine iron under #1/);
    assert.equal(rt.goals.all("sp:test").length, 2);
  },
  goal_update: async ({ tool }) => {
    await tool("goal_add", { title: "Iron kit" });
    await tool("goal_add", { title: "Mine iron", parent: 1 });
    const done = await tool("goal_update", { id: 2, status: "done", outcome: "12 raw iron" });
    assert.match(done, /^#2 \[done\] Mine iron\nall subgoals of #1 are closed/);
    assert.match(await tool("goal_update", { id: 1, status: "done" }), /no open goals left/);
    assert.equal(await tool("goal_update", { id: 1, delete: true }), "deleted #1 and its subgoals");
  },
  goal_list: async ({ tool }) => {
    assert.equal(await tool("goal_list"), "no goals yet — add one with goal_add");
    await tool("goal_add", { title: "Shelter", detail: "before night" });
    await tool("goal_add", { title: "Old plan" });
    await tool("goal_update", { id: 2, status: "dropped" });
    const list = await tool("goal_list");
    assert.match(list, /#1 \[pending\] Shelter ◀ next/);
    assert.match(list, /next detail: before night/);
    assert.doesNotMatch(list, /Old plan/);
    assert.match(await tool("goal_list", { all: true }), /Old plan/);
  },
  // planning
  plan_craft: async ({ world, tool }) => {
    world.give("minecraft:oak_log", 1);
    const plan = await tool("plan_craft", { item: "stick", count: 4 });
    assert.match(plan, /^# plan stick ×4 — craftable now from inventory/);
    assert.match(plan, /uses from inventory: oak_log×1/);
    assert.match(await tool("plan_craft", { item: "oak_log" }), /no recipe produces oak_log/);
  },
  get_recipes: async ({ tool }) => {
    const sticks = await tool("get_recipes", { item: "stick" });
    assert.match(sticks, /^crafting 1×2: stick×4 ← oak_planks\|birch_planks\|spruce_planks, oak_planks\|birch_planks\|spruce_planks$/);
    assert.match(await tool("get_recipes", { item: "iron_pickaxe" }), /crafting 3×3 \(locked\): iron_pickaxe×1/);
    assert.equal(await tool("get_recipes", { item: "diamond" }), "no recipes produce diamond");
  },
  explore_next: async ({ tool }) => {
    assert.equal(await tool("explore_next"), "the map is empty here — run observe first");
    await tool("observe", { radius: 1 });
    const next = (await tool("explore_next", { count: 2 })).split("\n");
    assert.equal(next.length, 2);
    for (const line of next) assert.match(line, /^chunk -?\d+,-?\d+ → walk to -?\d+ \d+ -?\d+ \(\d+ ?m? [NESW]{1,2}, via plains\)$/);
  },
  // jobs
  travel_to: async ({ world, tool }) => {
    const out = await tool("travel_to", { x: 30, z: -12, waitSeconds: 30 });
    assert.match(out, /\[done\]/);
    assert.ok(Math.hypot(world.player.x - 30, world.player.z + 12) < 4, "the player arrived");
    await assert.rejects(tool("travel_to", { x: 5 }), /give x and z/);
  },
  explore: async ({ world, rt, tool }) => {
    const out = await tool("explore", { legs: 1, waitSeconds: 30 });
    assert.match(out, /\[done\]/);
    assert.match(out, /done: 1 leg, \+\d+ chunks mapped/);
    assert.ok(rt.map.count("sp:test") > 0, "the walked area was mapped");
    assert.ok(world.calls.includes("nav.pathTo"), "it walked to a frontier");
  },
  collect_blocks: async ({ world, tool }) => {
    world.set({ x: 4, y: 64, z: 2 }, "minecraft:oak_log");
    const out = await tool("collect_blocks", { blocks: ["oak_log"], count: 1, waitSeconds: 30 });
    assert.match(out, /\[done\][\s\S]*broke 1\/1 oak_log; inventory \+oak_log×1/);
    assert.equal(world.count("minecraft:oak_log"), 1);
  },
  craft_item: async ({ world, tool }) => {
    world.give("minecraft:oak_planks", 2);
    const out = await tool("craft_item", { item: "stick", waitSeconds: 30 });
    assert.match(out, /\[done\]/);
    assert.equal(world.count("minecraft:stick"), 4);
    assert.equal(world.count("minecraft:oak_planks"), 0);
  },
  job_status: async ({ tool }) => {
    assert.equal(await tool("job_status", { waitSeconds: 0 }), "no jobs yet");
    await tool("travel_to", { x: 20, z: 20 });
    const status = await tool("job_status", { waitSeconds: 30 });
    assert.match(status, /#1 travel \[done\]/);
  },
  job_cancel: async ({ rt, session, tool }) => {
    assert.equal(await tool("job_cancel"), "no running job");
    const job = rt.jobs.start("wait", "sleep", (ctx) => ctx.sleep(10_000).then(() => "slept"), session.id);
    assert.equal(await tool("job_cancel"), `cancelled job #${job.id} (wait)`);
    assert.equal(rt.jobs.get(job.id)!.state, "cancelled");
  },
  // containers
  open_container: async ({ world, rt, tool }) => {
    withChest(world);
    const out = await tool("open_container", { x: 2, y: 64, z: 1 });
    assert.match(out, /^opened chest @ 2 64 1 \(generic_9x3, 27 slots\) · memory #1\ncontents: raw_iron×5$/);
    assert.deepEqual(rt.openContainer, { pos: { dim: "minecraft:overworld", x: 2, y: 64, z: 1 }, blockId: "minecraft:chest" });
  },
  container_transfer: async ({ world, rt, tool }) => {
    withChest(world);
    await tool("open_container", { x: 2, y: 64, z: 1 });
    const out = await tool("container_transfer", { direction: "take", item: "raw_iron" });
    assert.match(out, /^took raw_iron×5 · memory #1 updated\ncontainer now: empty$/);
    assert.equal(world.count("minecraft:raw_iron"), 5);
    assert.deepEqual(rt.memory.get("sp:test", 1)!.data?.items, {}, "the remembered contents follow the transfer");
  },
  close_container: async ({ world, rt, tool }) => {
    withChest(world);
    await tool("open_container", { x: 2, y: 64, z: 1 });
    assert.equal(await tool("close_container"), "closed");
    assert.equal(world.open, null);
    assert.equal(rt.openContainer, undefined);
  },
};

test("the agent tool table covers exactly AGENT_TOOLS", () => {
  assert.deepEqual(Object.keys(AGENT_TOOL_CASES).sort(), AGENT_TOOLS.map((t) => t.name).sort());
});

for (const [name, run] of Object.entries(AGENT_TOOL_CASES)) {
  test(`agent tool ${name}`, async () => {
    const h = setup();
    try {
      await run(h);
    } finally {
      await h.rt.jobs.cancel().catch(() => undefined);
      h.rt.close();
    }
  });
}
