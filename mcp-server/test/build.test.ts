import assert from "node:assert/strict";
import { test } from "node:test";

import type { Probe } from "../src/agent/build.js";
import { compilePlan, itemFor, keyOf, lint, materials, parseState, turnProps, walk } from "../src/agent/build.js";
import type { Pos } from "../src/agent/format.js";

test("block states parse into id and properties", () => {
  assert.deepEqual(parseState("oak_stairs[facing=north, half=top]"), { id: "minecraft:oak_stairs", props: { facing: "north", half: "top" } });
  assert.deepEqual(parseState("create:cogwheel"), { id: "create:cogwheel", props: {} });
  assert.throws(() => parseState("oak_stairs[facing"), /malformed/);
});

test("turning a plan turns facing, axis, rotation, side flags and rail shapes", () => {
  assert.deepEqual(turnProps({ facing: "north", half: "top", shape: "inner_left" }, 1), { facing: "east", half: "top", shape: "inner_left" });
  assert.deepEqual(turnProps({ axis: "x" }, 1), { axis: "z" });
  assert.deepEqual(turnProps({ axis: "y" }, 1), { axis: "y" });
  assert.deepEqual(turnProps({ rotation: "14" }, 1), { rotation: "2" });
  assert.deepEqual(turnProps({ north: "true", east: "false" }, 1), { east: "true", south: "false" });
  assert.deepEqual(turnProps({ shape: "north_south" }, 1), { shape: "east_west" });
  assert.deepEqual(turnProps({ shape: "south_east" }, 1), { shape: "south_west" });
  assert.deepEqual(turnProps({ shape: "north_east" }, 1), { shape: "south_east" });
  assert.deepEqual(turnProps({ shape: "ascending_north" }, 2), { shape: "ascending_south" });
  assert.deepEqual(turnProps({ facing: "up" }, 3), { facing: "up" });
});

test("a turned plan moves its cells so the plan's north ends up east", () => {
  // Two columns, three rows: S sits in the north-west corner and faces north.
  const plan = { name: "p", origin: { x: 10, y: 64, z: 20 }, palette: { S: "oak_stairs[facing=north]", "#": "stone" }, layers: [["S#", "##", "##"]] };
  const flat = compilePlan(plan);
  assert.deepEqual(flat.cells.find((c) => c.char === "S"), { x: 10, y: 64, z: 20, char: "S", want: { id: "minecraft:oak_stairs", props: { facing: "north" } } });
  const turned = compilePlan({ ...plan, rotate: 90 });
  // After a clockwise quarter turn the plan is 3 wide and 2 deep; the north-west corner is now north-east.
  assert.deepEqual({ min: turned.min, max: turned.max }, { min: { x: 10, y: 64, z: 20 }, max: { x: 12, y: 64, z: 21 } });
  assert.deepEqual(turned.cells.find((c) => c.char === "S"), { x: 12, y: 64, z: 20, char: "S", want: { id: "minecraft:oak_stairs", props: { facing: "east" } } });
});

test("unknown palette characters and reserved keys are refused", () => {
  assert.throws(() => compilePlan({ name: "p", origin: { x: 0, y: 0, z: 0 }, palette: {}, layers: [["#"]] }), /'#' is not in the palette/);
  assert.throws(() => compilePlan({ name: "p", origin: { x: 0, y: 0, z: 0 }, palette: { ".": "stone" }, layers: [["."]] }), /reserved/);
});

test("lint finds a blocked doorway, a torch on nothing and a stair without facing", () => {
  const c = compilePlan({
    name: "p",
    origin: { x: 0, y: 0, z: 0 },
    palette: { "#": "stone", D: "oak_door[facing=south,half=lower]", d: "oak_door[facing=south,half=upper]", T: "wall_torch[facing=east]", S: "oak_stairs" },
    layers: [["T.D", "S.#"], [" .d", "  #"]],
  });
  const warnings = lint(c);
  assert.ok(warnings.includes("oak_door @ 2 0 0: south of the door is stone — the doorway is blocked"), warnings.join("\n"));
  assert.ok(!warnings.some((w) => w.startsWith("wall_torch")), "nothing is planned west of the torch: unknown, no warning");
  assert.ok(warnings.includes("oak_stairs @ 0 0 1: no facing — it will face wherever the player looks"));
  const hanging = lint(compilePlan({ name: "p", origin: { x: 0, y: 0, z: 0 }, palette: { T: "wall_torch[facing=east]" }, layers: [[".T"]] }));
  assert.deepEqual(hanging, ["wall_torch @ 1 0 0: hangs on an empty cell (west of it)"]);
});

test("lint finds a roof slope built upside down", () => {
  // A south slope rising north to a ridge: stairs must face north (toward the ridge).
  const roof = (facing: string) => compilePlan({
    name: "p",
    origin: { x: 0, y: 0, z: 0 },
    palette: { S: `oak_stairs[facing=${facing},half=bottom]`, "#": "oak_planks" },
    layers: [["  ", " S"], [" #", "  "]],
  });
  assert.deepEqual(lint(roof("north")), []);
  assert.deepEqual(lint(roof("south")), ["oak_stairs @ 1 0 1: the slope rises to the north but the stair faces south — stairs climb toward their facing, so this slope is upside down (use facing=north)"]);
});

test("materials count items, not cells: one door for two halves, torch items for wall torches", () => {
  const c = compilePlan({
    name: "p",
    origin: { x: 0, y: 0, z: 0 },
    palette: { D: "oak_door[half=lower]", d: "oak_door[half=upper]", T: "wall_torch[facing=east]", s: "oak_slab[type=double]" },
    layers: [["DTs"], ["d"]],
  });
  assert.deepEqual(materials(c), { "minecraft:oak_door": 1, "minecraft:torch": 1, "minecraft:oak_slab": 2 });
  assert.equal(itemFor("minecraft:oak_wall_sign"), "minecraft:oak_sign");
  assert.equal(itemFor("minecraft:potted_poppy"), undefined);
});

/** A probe over a set of solid cells on a floor at y = 0 (everything else in the box is air). */
function world(solid: string[], extra: Record<string, Partial<Probe>> = {}) {
  const set = new Set(solid);
  return (p: Pos): Probe | undefined => {
    if (Math.abs(p.x) > 6 || Math.abs(p.z) > 6 || p.y < 0 || p.y > 4) return undefined;
    const k = keyOf(p);
    const x = extra[k];
    if (x) return { ...p, loaded: true, ...x };
    if (p.y === 0 || set.has(k)) return { ...p, loaded: true, id: "minecraft:stone", state: "minecraft:stone", air: false, height: 1 };
    return { ...p, loaded: true, id: "minecraft:air", state: "minecraft:air", air: true };
  };
}

test("walking: a wall with a gap is passable, a closed wall names the block to clear", () => {
  const span = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6];
  const wall = (gap: boolean) => span.flatMap((z) => (gap && z === 0 ? [] : [`0,1,${z}`, `0,2,${z}`, `0,3,${z}`]));
  assert.equal(walk(world(wall(true)), { x: -2, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }, false)?.ok, true);
  assert.equal(walk(world(wall(false)), { x: -2, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }, false), null);
  const dug = walk(world(wall(false)), { x: -2, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }, true)!;
  assert.equal(dug.cost, 2, "feet and head cell of the wall");
  assert.ok(dug.dug.every((p) => p.x === 0));
});

test("walking: doors can be opened, fences cannot be jumped, one block can be stepped up", () => {
  const span = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6];
  const wall = span.filter((z) => z !== 0).flatMap((z) => [`0,1,${z}`, `0,2,${z}`, `0,3,${z}`]);
  const door = { id: "minecraft:oak_door", state: "minecraft:oak_door[open=false]", air: false, height: 1 };
  const withDoor = world(wall, { "0,1,0": door, "0,2,0": door });
  assert.equal(walk(withDoor, { x: -2, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }, false)?.ok, true);
  const fence = { id: "minecraft:oak_fence", state: "minecraft:oak_fence", air: false, height: 1.5 };
  const fenced = world([], Object.fromEntries(span.map((z) => [`0,1,${z}`, fence])));
  assert.equal(walk(fenced, { x: -2, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }, false), null);
  assert.equal(walk(world(["1,1,0"]), { x: 0, y: 1, z: 0 }, { x: 1, y: 2, z: 0 }, false)?.ok, true, "step onto a block");
});
