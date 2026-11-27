/**
 * Sponge schematics (`.schem`, the format of WorldEdit 7 and FastAsyncWorldEdit) to build plans and
 * back. Reads versions 1 to 3 and writes version 2, which every current WorldEdit reads. Only blocks
 * are carried: block entities (chest contents, sign text), entities and biomes are left out.
 *
 * Files live in one folder (MCPFABRIC_SCHEMATICS_DIR, default ~/.mcpfabric/schematics) and are named
 * without a path, so a model cannot read or write anywhere else.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { ANY, EMPTY, compilePlan, formatState, parseState, type PlanInput } from "./build.js";
import type { Pos } from "./format.js";

/** Most a plan may span on each axis (the build_plan schema allows 64 layers, rows and columns). */
export const MAX_SIZE = 64;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_NBT_BYTES = 64 * 1024 * 1024;
/** The DataVersion written: Minecraft 1.21.1, the oldest version the mod supports. */
const DATA_VERSION = 3955;
const VOID = "minecraft:structure_void";
const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);

// ---- files ---------------------------------------------------------------------------------

export function schematicsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MCPFABRIC_SCHEMATICS_DIR || join(env.MCPFABRIC_DATA_DIR || join(homedir(), ".mcpfabric"), "schematics");
}

/** A file name in the schematics folder: no folders, ends with .schem. */
export function schematicPath(file: string, dir = schematicsDir()): string {
  const name = file.endsWith(".schem") ? file : `${file}.schem`;
  if (!/^[\w][\w .-]{0,79}\.schem$/.test(name) || name.includes("..")) {
    throw new Error(`"${file}" is not a schematic file name: use letters, digits, spaces, '.', '_' or '-', without folders`);
  }
  return join(dir, name);
}

export function readSchematicFile(file: string, dir = schematicsDir()): Buffer {
  const path = schematicPath(file, dir);
  if (!existsSync(path)) throw new Error(`no schematic "${file}" in ${dir}`);
  if (statSync(path).size > MAX_FILE_BYTES) throw new Error(`"${file}" is larger than ${MAX_FILE_BYTES / 1024 / 1024} MiB`);
  return readFileSync(path);
}

export function writeSchematicFile(file: string, data: Buffer, overwrite: boolean, dir = schematicsDir()): string {
  const path = schematicPath(file, dir);
  if (existsSync(path) && !overwrite) throw new Error(`"${file}" exists in ${dir}; pass overwrite to replace it`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, data);
  return path;
}

// ---- NBT -----------------------------------------------------------------------------------

type Nbt = number | bigint | string | Uint8Array | Int32Array | BigInt64Array | Nbt[] | NbtCompound;
interface NbtCompound {
  [key: string]: Nbt;
}

class Reader {
  private pos = 0;
  constructor(private readonly buf: Buffer) {}

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error("the schematic is truncated");
  }
  byte(): number {
    this.need(1);
    return this.buf.readInt8(this.pos++);
  }
  short(): number {
    this.need(2);
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  int(): number {
    this.need(4);
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  string(): string {
    const n = this.short() & 0xffff;
    this.need(n);
    const s = this.buf.toString("utf8", this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
  count(): number {
    const n = this.int();
    if (n < 0) throw new Error("the schematic has a negative length");
    return n;
  }

  payload(type: number, depth: number): Nbt {
    if (depth > 64) throw new Error("the schematic nests too deeply");
    switch (type) {
      case 1:
        return this.byte();
      case 2:
        return this.short();
      case 3:
        return this.int();
      case 4: {
        this.need(8);
        const v = this.buf.readBigInt64BE(this.pos);
        this.pos += 8;
        return v;
      }
      case 5: {
        this.need(4);
        const v = this.buf.readFloatBE(this.pos);
        this.pos += 4;
        return v;
      }
      case 6: {
        this.need(8);
        const v = this.buf.readDoubleBE(this.pos);
        this.pos += 8;
        return v;
      }
      case 7: {
        const n = this.count();
        this.need(n);
        const v = new Uint8Array(this.buf.subarray(this.pos, this.pos + n));
        this.pos += n;
        return v;
      }
      case 8:
        return this.string();
      case 9: {
        const t = this.byte();
        const n = this.count();
        if (t === 0 && n > 0) throw new Error("the schematic has a list of nothing");
        const out: Nbt[] = [];
        for (let i = 0; i < n; i++) out.push(this.payload(t, depth + 1));
        return out;
      }
      case 10: {
        const out: NbtCompound = {};
        for (;;) {
          const t = this.byte();
          if (t === 0) return out;
          const name = this.string();
          out[name] = this.payload(t, depth + 1);
        }
      }
      case 11: {
        const n = this.count();
        this.need(n * 4);
        const v = new Int32Array(n);
        for (let i = 0; i < n; i++) v[i] = this.int();
        return v;
      }
      case 12: {
        const n = this.count();
        this.need(n * 8);
        const v = new BigInt64Array(n);
        for (let i = 0; i < n; i++) {
          v[i] = this.buf.readBigInt64BE(this.pos);
          this.pos += 8;
        }
        return v;
      }
      default:
        throw new Error(`the schematic has an unknown NBT tag ${type}`);
    }
  }

  root(): NbtCompound {
    if (this.byte() !== 10) throw new Error("not a schematic: the file does not start with a compound tag");
    this.string();
    return this.payload(10, 0) as NbtCompound;
  }
}

/** Writes the few tag types a version 2 schematic needs. */
class Writer {
  private chunks: Buffer[] = [];
  private raw(b: Buffer): void {
    this.chunks.push(b);
  }
  private head(type: number, name: string): void {
    const n = Buffer.from(name, "utf8");
    const b = Buffer.alloc(3);
    b.writeInt8(type, 0);
    b.writeUInt16BE(n.length, 1);
    this.raw(b);
    this.raw(n);
  }
  open(name: string): void {
    this.head(10, name);
  }
  close(): void {
    this.raw(Buffer.from([0]));
  }
  short(name: string, v: number): void {
    this.head(2, name);
    const b = Buffer.alloc(2);
    b.writeInt16BE(v);
    this.raw(b);
  }
  int(name: string, v: number): void {
    this.head(3, name);
    const b = Buffer.alloc(4);
    b.writeInt32BE(v);
    this.raw(b);
  }
  intArray(name: string, v: number[]): void {
    this.head(11, name);
    const b = Buffer.alloc(4 + v.length * 4);
    b.writeInt32BE(v.length);
    v.forEach((x, i) => b.writeInt32BE(x, 4 + i * 4));
    this.raw(b);
  }
  bytes(name: string, v: Uint8Array): void {
    this.head(7, name);
    const b = Buffer.alloc(4);
    b.writeInt32BE(v.length);
    this.raw(b);
    this.raw(Buffer.from(v));
  }
  emptyCompoundList(name: string): void {
    this.head(9, name);
    const b = Buffer.alloc(5);
    b.writeInt8(10, 0);
    b.writeInt32BE(0, 1);
    this.raw(b);
  }
  done(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function varints(bytes: Uint8Array, count: number): number[] {
  const out: number[] = [];
  let i = 0;
  while (out.length < count) {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (i >= bytes.length) throw new Error("the schematic's block data is shorter than its size");
      const b = bytes[i++]!;
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) throw new Error("the schematic's block data has a malformed number");
    }
    out.push(value);
  }
  return out;
}

function toVarints(values: number[]): Uint8Array {
  const out: number[] = [];
  for (let v of values) {
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(v);
  }
  return Uint8Array.from(out);
}

// ---- schematic <-> blocks ------------------------------------------------------------------

/** Blocks of a schematic: `blocks[(y * length + z) * width + x]` is a full block state. */
export interface Schematic {
  width: number;
  height: number;
  length: number;
  blocks: string[];
}

const num = (v: Nbt | undefined, what: string): number => {
  if (typeof v !== "number") throw new Error(`not a schematic: ${what} is missing`);
  return v;
};

export function parseSchematic(file: Buffer): Schematic {
  let nbt: Buffer;
  try {
    nbt = file[0] === 0x1f && file[1] === 0x8b ? gunzipSync(file, { maxOutputLength: MAX_NBT_BYTES }) : file;
  } catch (err) {
    throw new Error(`the schematic could not be unpacked: ${(err as Error).message}`);
  }
  let root = new Reader(nbt).root();
  // Version 3 wraps everything in "Schematic"; versions 1 and 2 are the root itself.
  if (root.Schematic && typeof root.Schematic === "object" && !Array.isArray(root.Schematic)) root = root.Schematic as NbtCompound;
  const width = num(root.Width, "Width") & 0xffff;
  const height = num(root.Height, "Height") & 0xffff;
  const length = num(root.Length, "Length") & 0xffff;
  if (width < 1 || height < 1 || length < 1) throw new Error("the schematic is empty");
  if (width > MAX_SIZE || height > MAX_SIZE || length > MAX_SIZE) {
    throw new Error(`the schematic is ${width}x${height}x${length} (width x height x length); plans go up to ${MAX_SIZE} on each side`);
  }
  const container = root.Blocks && typeof root.Blocks === "object" && !Array.isArray(root.Blocks) ? (root.Blocks as NbtCompound) : root;
  const palette = container.Palette;
  const data = container.Data ?? container.BlockData;
  if (!palette || typeof palette !== "object" || Array.isArray(palette) || palette instanceof Uint8Array) throw new Error("not a schematic: no block palette");
  if (!(data instanceof Uint8Array)) throw new Error("not a schematic: no block data");
  const byIndex = new Map<number, string>();
  for (const [state, index] of Object.entries(palette as NbtCompound)) {
    if (typeof index === "number") byIndex.set(index, state);
  }
  const blocks = varints(data, width * height * length).map((i) => {
    const s = byIndex.get(i);
    if (s === undefined) throw new Error(`the schematic uses palette index ${i}, which its palette does not have`);
    return s;
  });
  return { width, height, length, blocks };
}

export function writeSchematic(s: Schematic): Buffer {
  const palette = new Map<string, number>();
  const data = s.blocks.map((b) => {
    let i = palette.get(b);
    if (i === undefined) palette.set(b, (i = palette.size));
    return i;
  });
  const w = new Writer();
  w.open("Schematic");
  w.int("Version", 2);
  w.int("DataVersion", DATA_VERSION);
  w.short("Width", s.width);
  w.short("Height", s.height);
  w.short("Length", s.length);
  w.intArray("Offset", [0, 0, 0]);
  w.int("PaletteMax", palette.size);
  w.open("Palette");
  for (const [state, i] of palette) w.int(state, i);
  w.close();
  w.bytes("BlockData", toVarints(data));
  w.emptyCompoundList("BlockEntities");
  w.close();
  return gzipSync(w.done());
}

// ---- schematic <-> plan --------------------------------------------------------------------

/**
 * Properties the game sets from the neighbours when a block is placed (fence and wall connections,
 * stair corners, leaf distance, snowy grass): a plan that pinned them would report every fence as
 * wrong, so they are left free.
 */
function freeProps(id: string, props: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    if (["north", "east", "south", "west"].includes(k) && ["true", "false", "none", "low", "tall", "side", "up"].includes(v)) continue;
    if (k === "up" && (id.endsWith("_wall") || id === "minecraft:fire")) continue;
    if (k === "shape" && id.endsWith("_stairs")) continue;
    if (k === "distance" || k === "snowy" || (k === "waterlogged" && v === "false")) continue;
    out[k] = v;
  }
  return out;
}

/** Palette characters: letters and digits first, then a run of CJK ideographs (one character each). */
function paletteChar(i: number): string {
  const easy = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#@$%&*+=?!";
  return i < easy.length ? easy[i]! : String.fromCodePoint(0x4e00 + i - easy.length);
}

export interface ImportOptions {
  name: string;
  origin: Pos;
  rotate?: 0 | 90 | 180 | 270;
  /** What air in the schematic means: "any" leaves the cell alone (default), "empty" requires it to be empty. */
  air?: "any" | "empty";
}

export function schematicToPlan(s: Schematic, opts: ImportOptions): PlanInput {
  const chars = new Map<string, string>();
  const palette: Record<string, string> = {};
  const layers: string[][] = [];
  for (let y = 0; y < s.height; y++) {
    const layer: string[] = [];
    for (let z = 0; z < s.length; z++) {
      let row = "";
      for (let x = 0; x < s.width; x++) {
        const state = s.blocks[(y * s.length + z) * s.width + x]!;
        const wanted = parseState(state);
        if (wanted.id === VOID) row += ANY;
        else if (AIR.has(wanted.id)) row += opts.air === "empty" ? EMPTY : ANY;
        else {
          const text = formatState({ id: wanted.id, props: freeProps(wanted.id, wanted.props) });
          let ch = chars.get(text);
          if (ch === undefined) {
            ch = paletteChar(chars.size);
            chars.set(text, ch);
            palette[ch] = text;
          }
          row += ch;
        }
      }
      layer.push(row);
    }
    layers.push(layer);
  }
  if (chars.size === 0 && opts.air !== "empty") throw new Error("the schematic has only air");
  return { name: opts.name, origin: opts.origin, ...(opts.rotate ? { rotate: opts.rotate } : {}), palette, layers };
}

/** A plan as a schematic, unturned: cells not checked become structure voids, empty cells air. */
export function planToSchematic(plan: PlanInput): Schematic {
  compilePlan(plan); // the same checks as build_plan
  const height = plan.layers.length;
  const length = Math.max(1, ...plan.layers.map((l) => l.length));
  const width = Math.max(1, ...plan.layers.flatMap((l) => l.map((r) => [...r].length)));
  const blocks: string[] = new Array(width * height * length).fill(VOID);
  plan.layers.forEach((layer, y) =>
    layer.forEach((row, z) =>
      [...row].forEach((ch, x) => {
        const i = (y * length + z) * width + x;
        if (ch === EMPTY) blocks[i] = "minecraft:air";
        else if (ch !== ANY) blocks[i] = formatState(parseState(plan.palette[ch]!));
      }),
    ),
  );
  return { width, height, length, blocks };
}
