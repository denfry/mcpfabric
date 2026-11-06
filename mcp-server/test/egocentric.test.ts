import assert from "node:assert/strict";
import { test } from "node:test";

import { describe, facing, relative } from "../src/agent/egocentric.js";

test("directions follow Minecraft yaw: 0 south, 90 west, 180 north, -90 east", () => {
  assert.equal(facing(0), "south");
  assert.equal(facing(90), "west");
  assert.equal(facing(-180), "north");
  assert.equal(facing(270), "east");
  assert.equal(facing(-45), "south-east");
  const at = { x: 0, y: 64, z: 0 };
  // Facing north (yaw 180): east (+x) is to the right.
  const r = relative({ ...at, yaw: 180 }, { x: 3, y: 65, z: -4 });
  assert.equal(Math.round(r.ahead), 4);
  assert.equal(Math.round(r.right), 3);
  assert.equal(r.up, 1);
  assert.equal(r.clock, 1);
  assert.equal(describe(r), "4 ahead, 3 right, 1 up · 5.1 m (1 o'clock)");
  // Facing east (yaw -90): south (+z) is to the right, straight behind is 6 o'clock.
  assert.equal(Math.round(relative({ ...at, yaw: -90 }, { x: 0, y: 64, z: 2 }).right), 2);
  assert.equal(relative({ ...at, yaw: -90 }, { x: -5, y: 64, z: 0 }).clock, 6);
  assert.equal(describe(relative({ ...at, yaw: 0 }, at)), "right here · 0.0 m (12 o'clock)");
});
