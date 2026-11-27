import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { compilePlan, type PlanInput } from "../src/agent/build.js";
import {
  parseSchematic,
  planToSchematic,
  readSchematicFile,
  schematicPath,
  schematicsDir,
  schematicToPlan,
  writeSchematic,
  writeSchematicFile,
} from "../src/agent/schematic.js";

const origin = { x: 100, y: 64, z: -20 };

const PLAN: PlanInput = {
  name: "hut",
  origin,
  palette: { P: "oak_planks", S: "oak_stairs[facing=north,half=bottom]", D: "oak_door[facing=south,half=lower,hinge=left]" },
  layers: [
    ["PPP", "P.D", "PPP"],
    ["SSS", " . ", "SSS"],
  ],
};

/** A tiny NBT writer for hand-made files (version 3 layout, broken files). */
function nbt(parts: Buffer[]): Buffer {
  return gzipSync(Buffer.concat(parts));
}
const name = (type: number, n: string) => {
  const b = Buffer.alloc(3 + Buffer.byteLength(n));
  b.writeInt8(type, 0);
  b.writeUInt16BE(Buffer.byteLength(n), 1);
  b.write(n, 3);
  return b;
};
const short = (n: string, v: number) => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(v);
  return Buffer.concat([name(2, n), b]);
};
const int = (n: string, v: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v);
  return Buffer.concat([name(3, n), b]);
};
const bytes = (n: string, v: number[]) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v.length);
  return Buffer.concat([name(7, n), b, Buffer.from(v)]);
};
const compound = (n: string, body: Buffer[]) => Buffer.concat([name(10, n), ...body, Buffer.from([0])]);

test("a plan survives a trip through a schematic", () => {
  const s = planToSchematic(PLAN);
  assert.deepEqual([s.width, s.height, s.length], [3, 2, 3]);
  const back = parseSchematic(writeSchematic(s));
  assert.deepEqual(back, s);
  const plan = schematicToPlan(back, { name: "hut2", origin, air: "empty" });
  // Same cells and blocks as the original.
  const a = compilePlan(PLAN).cells.map((c) => `${c.x},${c.y},${c.z}=${c.want ? `${c.want.id}${JSON.stringify(c.want.props)}` : "."}`).sort();
  const b = compilePlan(plan).cells.map((c) => `${c.x},${c.y},${c.z}=${c.want ? `${c.want.id}${JSON.stringify(c.want.props)}` : "."}`).sort();
  assert.deepEqual(b, a);
});

test("cells not checked become structure voids, empty cells air; air imports as 'any' by default", () => {
  const s = planToSchematic(PLAN);
  assert.equal(s.blocks[(1 * 3 + 1) * 3 + 0], "minecraft:structure_void");
  assert.equal(s.blocks[(1 * 3 + 1) * 3 + 1], "minecraft:air");
  const plan = schematicToPlan(s, { name: "x", origin });
  assert.equal(plan.layers[1]![1], "   ");
  assert.equal(plan.layers[0]![1]![1], " ");
});

test("properties the game sets from the neighbours are left free", () => {
  const s = {
    width: 4,
    height: 1,
    length: 1,
    blocks: [
      "minecraft:oak_fence[east=true,north=false,south=false,waterlogged=false,west=false]",
      "minecraft:oak_stairs[facing=east,half=top,shape=inner_left,waterlogged=false]",
      "minecraft:rail[shape=north_east,waterlogged=false]",
      "minecraft:cobblestone_wall[east=low,north=none,south=tall,up=true,waterlogged=true,west=none]",
    ],
  };
  const plan = schematicToPlan(s, { name: "x", origin });
  assert.deepEqual(Object.values(plan.palette), [
    "minecraft:oak_fence",
    "minecraft:oak_stairs[facing=east,half=top]",
    "minecraft:rail[shape=north_east]",
    "minecraft:cobblestone_wall[waterlogged=true]",
  ]);
});

test("many block states get one character each", () => {
  const blocks = Array.from({ length: 100 }, (_, i) => `minecraft:note_block[note=${i % 25},instrument=i${Math.floor(i / 25)}]`);
  const plan = schematicToPlan({ width: 50, height: 1, length: 2, blocks }, { name: "x", origin });
  assert.equal(Object.keys(plan.palette).length, 100);
  assert.equal(compilePlan(plan).cells.length, 100);
});

test("reads the version 3 layout", () => {
  const file = nbt([
    compound("", [
      compound("Schematic", [
        int("Version", 3),
        int("DataVersion", 4189),
        short("Width", 2),
        short("Height", 1),
        short("Length", 1),
        compound("Blocks", [compound("Palette", [int("minecraft:stone", 0), int("minecraft:dirt", 1)]), bytes("Data", [1, 0])]),
      ]),
    ]),
  ]);
  assert.deepEqual(parseSchematic(file), { width: 2, height: 1, length: 1, blocks: ["minecraft:dirt", "minecraft:stone"] });
});

test("refuses schematics that are too big, broken or not schematics", () => {
  const big = nbt([compound("", [short("Width", 65), short("Height", 1), short("Length", 1), compound("Palette", [int("minecraft:stone", 0)]), bytes("BlockData", [0])])]);
  assert.throws(() => parseSchematic(big), /65x1x1.*up to 64/);
  const short_ = nbt([compound("", [short("Width", 2), short("Height", 1), short("Length", 1), compound("Palette", [int("minecraft:stone", 0)]), bytes("BlockData", [0])])]);
  assert.throws(() => parseSchematic(short_), /shorter than its size/);
  const badIndex = nbt([compound("", [short("Width", 1), short("Height", 1), short("Length", 1), compound("Palette", [int("minecraft:stone", 0)]), bytes("BlockData", [5])])]);
  assert.throws(() => parseSchematic(badIndex), /palette index 5/);
  assert.throws(() => parseSchematic(gzipSync(Buffer.from([10, 0, 0, 3]))), /truncated/);
  assert.throws(() => parseSchematic(Buffer.from("hello")), /not a schematic/);
  const air = nbt([compound("", [short("Width", 1), short("Height", 1), short("Length", 1), compound("Palette", [int("minecraft:air", 0)]), bytes("BlockData", [0])])]);
  assert.throws(() => schematicToPlan(parseSchematic(air), { name: "x", origin }), /only air/);
});

test("schematic files stay in their folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "schem-"));
  assert.equal(schematicPath("tower", dir), join(dir, "tower.schem"));
  for (const bad of ["../x.schem", "a/b.schem", "a\b.schem", "C:x.schem", ".hidden.schem", "x..schem", ""]) {
    assert.throws(() => schematicPath(bad, dir), /not a schematic file name/, bad);
  }
  const data = writeSchematic(planToSchematic(PLAN));
  const path = writeSchematicFile("hut.schem", data, false, dir);
  assert.ok(existsSync(path));
  assert.throws(() => writeSchematicFile("hut", data, false, dir), /exists/);
  writeSchematicFile("hut", data, true, dir);
  assert.deepEqual(readSchematicFile("hut", dir), readFileSync(path));
  assert.throws(() => readSchematicFile("missing", dir), /no schematic "missing"/);
  assert.equal(schematicsDir({ MCPFABRIC_SCHEMATICS_DIR: "/s" }), "/s");
  assert.equal(schematicsDir({ MCPFABRIC_DATA_DIR: "/d" }), join("/d", "schematics"));
});

test("block states that are not plain ids and properties are refused", () => {
  for (const bad of ['minecraft:stone{Lock:"x"}', "minecraft:stone run say hi", 'minecraft:chest[facing=north,x="y"]', "minecraft:stone[facing=north up]"]) {
    assert.throws(() => schematicToPlan({ width: 1, height: 1, length: 1, blocks: [bad] }, { name: "x", origin }), /malformed/, bad);
    assert.throws(() => compilePlan({ name: "x", origin, palette: { A: bad }, layers: [["A"]] }), /malformed/, bad);
  }
  assert.doesNotThrow(() => compilePlan({ name: "x", origin, palette: { A: "create:andesite_casing", B: "minecraft:oak_stairs[facing=north,half=top]" }, layers: [["AB"]] }));
});

test("a file with millions of tiny tags is refused before it fills the memory", () => {
  // A list of 3,000,000 empty compounds: about 3 MB unpacked.
  const count = 3_000_000;
  const head = Buffer.alloc(5);
  head.writeInt8(10, 0);
  head.writeInt32BE(count, 1);
  const file = nbt([compound("", [name(9, "Junk"), head, Buffer.alloc(count, 0)])]);
  assert.throws(() => parseSchematic(file), /more than 2000000 tags/);
});
