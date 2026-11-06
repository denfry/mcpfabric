import assert from "node:assert/strict";
import { test } from "node:test";

import type { Bridge } from "../src/agent/body.js";
import { checkTask, setupTask } from "../src/bench/runner.js";
import { TASKS, taskById } from "../src/bench/tasks.js";

/** Records commands; the inventory and position are whatever the test sets. */
class FakeBridge implements Bridge {
  commands: string[] = [];
  items: { slot: number; id: string; count: number }[] = [];
  pos = { x: 10.5, y: 64, z: -3.5 };
  failCommand?: string;
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    switch (method) {
      case "player.getState":
        return { ...this.pos, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, dimension: "minecraft:overworld", gameMode: "survival", onGround: true, inWater: false, selectedSlot: 0 } as T;
      case "player.getInventory":
        return { selectedSlot: 0, hotbar: this.items.filter((i) => i.slot < 9), main: this.items.filter((i) => i.slot >= 9) } as T;
      case "command.run": {
        const command = String(params.command);
        this.commands.push(command);
        return { command, success: command !== this.failCommand, resultValue: 1 } as T;
      }
      default:
        throw new Error(`unexpected ${method}`);
    }
  }
}

test("task ids are unique and every task starts from the common clean state", () => {
  assert.equal(new Set(TASKS.map((t) => t.id)).size, TASKS.length);
  for (const t of TASKS) {
    const cmds = t.setup(7);
    assert.ok(cmds.includes("clear @p") && cmds.includes("gamemode survival @p"), t.id);
    assert.deepEqual(t.setup(7), cmds, `${t.id} setup is deterministic for a seed`);
  }
});

test("a setup records the start, and a failed command stops it", async () => {
  const b = new FakeBridge();
  const started = await setupTask(b, taskById("crafting_table"), 3);
  assert.equal(started.start.x, 10.5);
  assert.ok(b.commands.includes("give @p minecraft:oak_log 2"));
  b.failCommand = "give @p minecraft:oak_log 2";
  await assert.rejects(setupTask(b, taskById("crafting_table"), 3), /setup command failed/);
});

test("checks read the inventory and the position", async () => {
  const b = new FakeBridge();
  const logs = await setupTask(b, taskById("logs"), 1);
  b.items = [{ slot: 0, id: "minecraft:oak_log", count: 5 }, { slot: 12, id: "minecraft:birch_log", count: 2 }, { slot: 3, id: "minecraft:stripped_oak_log", count: 9 }];
  assert.deepEqual(await checkTask(b, logs), { pass: false, detail: "7 logs" });
  b.items.push({ slot: 4, id: "minecraft:crimson_stem", count: 1 });
  assert.equal((await checkTask(b, logs)).pass, true);

  const climb = await setupTask(b, taskById("climb"), 1);
  b.pos = { x: 13.2, y: 68, z: -3.5 };
  assert.equal((await checkTask(b, climb)).pass, true);
  b.pos = { x: 13.2, y: 66, z: -3.5 };
  assert.equal((await checkTask(b, climb)).pass, false);
});

test("the marked block check uses the same offset as its setup", async () => {
  const b = new FakeBridge();
  const t = taskById("goto_beacon");
  const started = await setupTask(b, t, 42);
  const fill = b.commands.find((c) => c.includes("glowstone"))!;
  const [, dx, dz] = /~(-?\d+) ~ ~(-?\d+)/.exec(fill)!.map(Number);
  b.pos = { x: 10 + dx! + 0.5 + 1, y: 64, z: -4 + dz! + 0.5 };
  assert.equal((await checkTask(b, started)).pass, true);
  b.pos = { x: 10.5, y: 64, z: -3.5 };
  assert.equal((await checkTask(b, started)).pass, false);
});
