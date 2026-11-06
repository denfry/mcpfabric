import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentRuntime } from "../src/agent/runtime.js";
import { stopEverything } from "../src/dashboard/register.js";
import { summarize, takeSnapshot } from "../src/dashboard/snapshot.js";
import { dashboardHtml } from "../src/dashboard/view.js";
import { FakeWorld } from "./fake-world.js";

test("the snapshot carries position, vitals, inventory, goals and the map", async () => {
  const world = new FakeWorld().give("minecraft:oak_log", 5).give("minecraft:cobblestone", 12);
  const rt = new AgentRuntime(world, { dbPath: ":memory:" });
  try {
    const w = await rt.world();
    const root = rt.goals.add(w, { title: "Get a stone pickaxe" });
    rt.goals.add(w, { title: "Collect logs", parentId: root.id });
    await rt.observe({ radius: 2 });
    const s = await takeSnapshot(rt, world);
    assert.equal(s.world, "sp:test");
    assert.deepEqual(s.at, { dim: "minecraft:overworld", x: 0, y: 64, z: 0 });
    assert.deepEqual(s.inventory, [{ id: "cobblestone", count: 12 }, { id: "oak_log", count: 5 }]);
    assert.deepEqual(s.goals.map((g) => [g.title, g.depth]), [["Get a stone pickaxe", 0], ["Collect logs", 1]]);
    assert.equal(s.goals.filter((g) => g.next).length, 1);
    assert.equal(s.map.rows.length, 17);
    assert.ok(s.map.rows[8]!.includes("@"), "the player is in the middle row");
    assert.equal(s.job, null);
    assert.match(summarize(s), /2 open goals · no job running/);
  } finally {
    rt.close();
  }
});

test("STOP releases the body even when some stop calls fail", async () => {
  const world = new FakeWorld();
  const rt = new AgentRuntime(world, { dbPath: ":memory:" });
  try {
    const text = await stopEverything(rt, world);
    assert.ok(world.calls.includes("nav.stop") && world.calls.includes("interact.stopBreaking"));
    assert.match(text, /^Stopped: movement, navigation and mining released/);
  } finally {
    rt.close();
  }
});

test("the view is one page with the ext-apps client inlined as a classic script", () => {
  const html = dashboardHtml();
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("window.__mcpApps={"), "bundle exports rewritten");
  assert.ok(html.includes('"App":'), "the App class is exposed");
  assert.ok(!/\bexport\s*\{[^}]*\}\s*;?\s*\n?window/.test(html), "no module export left");
  assert.ok(html.includes("dashboard_state") && html.includes("dashboard_stop"));
});
