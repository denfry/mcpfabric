/**
 * Building from a plan: the plan says which block (and which properties) belongs in every cell and
 * which cells must stay empty (doorways, head room, the space a door swings into). It is checked
 * before building (lint, materials) and compared with the world afterwards (verify), including
 * whether the marked spots can still be walked to — so a block facing the wrong way or a doorway
 * that got filled is reported instead of going unnoticed.
 */
import type { BlockProbe } from "./body.js";
import { fmtItems, fmtPos, fullId, shortId, type Pos } from "./format.js";

/** A cell nobody cares about, and a cell that must stay empty. */
export const ANY = " ";
export const EMPTY = ".";

export interface PlanSpot {
  name: string;
  /** Plan coordinates: column (west → east), layer (bottom → top), row (north → south). */
  x: number;
  y: number;
  z: number;
}

export interface PlanInput {
  name: string;
  /** World position of the plan's lowest north-west corner after rotation. */
  origin: Pos;
  /** Clockwise quarter turn, seen from above: 90 turns the plan's north to the east. */
  rotate?: 0 | 90 | 180 | 270;
  /** One character → block, optionally with properties: `"S": "oak_stairs[facing=north]"`. */
  palette: Record<string, string>;
  /** Layers bottom-up; each layer is rows north → south, each row a string of palette characters west → east. */
  layers: string[][];
  /** Places to stand that must be reachable on foot from the first one (an entrance outside, the bed, the chest). */
  spots?: PlanSpot[];
}

export interface Plan extends PlanInput {
  dim: string;
}

export interface Wanted {
  id: string;
  /** Only these properties are checked; the rest are free (stairs shape, fence connections...). */
  props: Record<string, string>;
}

export interface Cell extends Pos {
  char: string;
  /** Undefined for a cell that must stay empty. */
  want?: Wanted;
}

export interface Compiled {
  cells: Cell[];
  byKey: Map<string, Cell>;
  spots: (Pos & { name: string })[];
  min: Pos;
  max: Pos;
}

export const keyOf = (p: Pos) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

/** `oak_stairs[facing=north]` → id and properties. */
export function parseState(text: string): Wanted {
  const s = text.trim().toLowerCase();
  const open = s.indexOf("[");
  if (open < 0) return { id: fullId(s), props: {} };
  if (!s.endsWith("]")) throw new Error(`malformed block state: ${text}`);
  const props: Record<string, string> = {};
  for (const pair of s.slice(open + 1, -1).split(",")) {
    if (!pair.trim()) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`malformed property '${pair}' in ${text}`);
    props[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return { id: fullId(s.slice(0, open)), props };
}

export function formatState(w: Wanted): string {
  const props = Object.entries(w.props);
  return props.length ? `${w.id}[${props.map(([k, v]) => `${k}=${v}`).join(",")}]` : w.id;
}

// ----- rotation ---------------------------------------------------------------------------------

const DIRS = ["north", "east", "south", "west"];

function turnDir(d: string, q: number): string {
  const i = DIRS.indexOf(d);
  return i < 0 ? d : DIRS[(i + q) % 4]!;
}

/** `north_south`, `south_east`, `ascending_west` and the like, turned and written the way the game names them. */
function turnShape(value: string, q: number): string {
  const tokens = value.split("_").map((t) => turnDir(t, q));
  const horizontal = tokens.filter((t) => DIRS.includes(t));
  if (tokens.length === 2 && horizontal.length === 2) {
    const set = new Set(tokens);
    if (set.has("north") && set.has("south")) return "north_south";
    if (set.has("east") && set.has("west")) return "east_west";
    return tokens[0] === "east" || tokens[0] === "west" ? `${tokens[1]}_${tokens[0]}` : tokens.join("_");
  }
  return tokens.join("_");
}

/** The properties of a block turned by `q` clockwise quarter turns. */
export function turnProps(props: Record<string, string>, q: number): Record<string, string> {
  if (q % 4 === 0) return { ...props };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    if (DIRS.includes(k)) out[turnDir(k, q)] = v;
    else if (k === "facing" || k === "horizontal_facing") out[k] = turnDir(v, q);
    else if (k === "axis" && q % 2 === 1 && (v === "x" || v === "z")) out[k] = v === "x" ? "z" : "x";
    else if (k === "rotation" && /^\d+$/.test(v)) out[k] = String((Number(v) + 4 * q) % 16);
    else if (k === "shape" || k === "orientation") out[k] = turnShape(v, q);
    else out[k] = v;
  }
  return out;
}

// ----- compile ----------------------------------------------------------------------------------

export function compilePlan(plan: PlanInput): Compiled {
  const q = ((plan.rotate ?? 0) / 90) % 4;
  const palette = new Map<string, Wanted>();
  for (const [ch, state] of Object.entries(plan.palette)) {
    if ([...ch].length !== 1) throw new Error(`palette keys are single characters, got '${ch}'`);
    if (ch === ANY || ch === EMPTY) throw new Error(`'${ch}' is reserved (' ' = any block, '.' = must stay empty)`);
    palette.set(ch, parseState(state));
  }
  const width = Math.max(1, ...plan.layers.flatMap((l) => l.map((r) => [...r].length)));
  const depth = Math.max(1, ...plan.layers.map((l) => l.length));
  const place = (c: number, l: number, r: number): Pos => {
    const [x, z] = q === 0 ? [c, r] : q === 1 ? [depth - 1 - r, c] : q === 2 ? [width - 1 - c, depth - 1 - r] : [r, width - 1 - c];
    return { x: Math.floor(plan.origin.x) + x, y: Math.floor(plan.origin.y) + l, z: Math.floor(plan.origin.z) + z };
  };
  const cells: Cell[] = [];
  const byKey = new Map<string, Cell>();
  plan.layers.forEach((layer, l) => {
    layer.forEach((row, r) => {
      [...row].forEach((ch, c) => {
        if (ch === ANY) return;
        let want: Wanted | undefined;
        if (ch !== EMPTY) {
          const w = palette.get(ch);
          if (!w) throw new Error(`layer ${l} row ${r} column ${c}: '${ch}' is not in the palette`);
          want = { id: w.id, props: turnProps(w.props, q) };
        }
        const cell: Cell = { ...place(c, l, r), char: ch, ...(want ? { want } : {}) };
        cells.push(cell);
        byKey.set(keyOf(cell), cell);
      });
    });
  });
  if (cells.length === 0) throw new Error("the plan has no cells");
  const spots = (plan.spots ?? []).map((s) => ({ name: s.name, ...place(s.x, s.y, s.z) }));
  const { min, max } = bounds(cells);
  return { cells, byKey, spots, min, max };
}

function bounds(ps: Pos[]): { min: Pos; max: Pos } {
  return {
    min: { x: Math.min(...ps.map((p) => p.x)), y: Math.min(...ps.map((p) => p.y)), z: Math.min(...ps.map((p) => p.z)) },
    max: { x: Math.max(...ps.map((p) => p.x)), y: Math.max(...ps.map((p) => p.y)), z: Math.max(...ps.map((p) => p.z)) },
  };
}

// ----- block knowledge --------------------------------------------------------------------------

const STEP: Record<string, Pos> = {
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  down: { x: 0, y: -1, z: 0 },
};
const OPPOSITE: Record<string, string> = { north: "south", south: "north", east: "west", west: "east", up: "down", down: "up" };

const add = (p: Pos, d: Pos): Pos => ({ x: p.x + d.x, y: p.y + d.y, z: p.z + d.z });

/** Blocks whose placement follows where the player looks unless the plan pins it. */
const NEEDS_FACING = /(_stairs|_door|_trapdoor|wall_torch|ladder|chest|furnace|smoker|_bed|_fence_gate|barrel|observer|piston|dispenser|dropper|lectern|repeater|comparator|_wall_sign|_wall_banner|carved_pumpkin|jack_o_lantern|loom|stonecutter|beehive|bee_nest|anvil|_glazed_terracotta)$/;
const NEEDS_AXIS = /(_log|_wood|_stem|_hyphae|hay_block|_pillar|basalt|bone_block|chain|purpur_pillar)$/;
/** Hangs on the block behind it (opposite of its facing). */
const WALL_MOUNTED = /(wall_torch|ladder|_wall_sign|_wall_banner|_button|lever|tripwire_hook|_wall_hanging_sign)$/;
/** Needs a block below. */
const FLOOR_MOUNTED = /(^minecraft:torch|soul_torch|redstone_torch|_carpet|_pressure_plate|rail|_sapling|flower|tulip|poppy|dandelion|_sign|_banner|candle|_door|lantern|repeater|comparator|redstone_wire|snow)$/;
/** Doors and gates the walker can open on its way. */
export const OPENABLE = /(?<!iron)_door$|_fence_gate$/;

/** The second half the game places together with the first: not placed separately. */
export function isPartner(w: Wanted): boolean {
  if (/_door$|tall_grass|large_fern|sunflower|lilac|rose_bush|peony|pitcher_plant|tall_seagrass|small_dripleaf/.test(w.id)) return w.props.half === "upper";
  if (/_bed$/.test(w.id)) return w.props.part === "head";
  return false;
}

/** The item that places a block (most blocks share their id with it). */
export function itemFor(id: string): string | undefined {
  if (/^minecraft:potted_/.test(id) || id === "minecraft:air" || /piston_head|moving_piston|fire$/.test(id)) return undefined;
  if (id === "minecraft:redstone_wire") return "minecraft:redstone";
  if (id === "minecraft:tripwire") return "minecraft:string";
  return id
    .replace(/wall_torch$/, "torch")
    .replace(/_wall_hanging_sign$/, "_hanging_sign")
    .replace(/_wall_sign$/, "_sign")
    .replace(/_wall_banner$/, "_banner")
    .replace(/_wall_head$/, "_head")
    .replace(/_wall_skull$/, "_skull")
    .replace(/_wall_fan$/, "_fan");
}

/** Items needed for the plan's blocks (partner halves are free, double slabs take two). */
export function materials(c: Compiled): Record<string, number> {
  const out: Record<string, number> = {};
  for (const cell of c.cells) {
    if (!cell.want || isPartner(cell.want)) continue;
    const item = itemFor(cell.want.id);
    if (!item) continue;
    out[item] = (out[item] ?? 0) + (cell.want.props.type === "double" && /_slab$/.test(cell.want.id) ? 2 : 1);
  }
  return out;
}

/** Placed by the build after the solid blocks, because they hang on or stand on them. */
export function isAttachable(w: Wanted): boolean {
  return WALL_MOUNTED.test(w.id) || FLOOR_MOUNTED.test(w.id) || /_bed$|_trapdoor$|_head$|_skull$/.test(w.id);
}

// ----- lint -------------------------------------------------------------------------------------

/** Problems the plan has before anything is built. */
export function lint(c: Compiled): string[] {
  const out: string[] = [];
  const at = (p: Pos) => c.byKey.get(keyOf(p));
  const solid = (cell: Cell | undefined) => !!cell?.want && !isAttachable(cell.want) && !OPENABLE.test(cell.want.id);
  for (const cell of c.cells) {
    const w = cell.want;
    if (!w) continue;
    const name = `${shortId(w.id)} @ ${fmtPos(cell)}`;
    if (NEEDS_FACING.test(w.id) && !w.props.facing) out.push(`${name}: no facing — it will face wherever the player looks`);
    if (NEEDS_AXIS.test(w.id) && !w.props.axis) out.push(`${name}: no axis — it follows the clicked face`);
    if (/_slab$/.test(w.id) && !w.props.type) out.push(`${name}: no type (bottom/top/double)`);
    if (/_door$/.test(w.id) && w.props.half !== "upper") {
      const above = at(add(cell, STEP.up!));
      if (above && (!above.want || above.want.id !== w.id)) out.push(`${name}: the cell above is not the upper half of the door`);
      const f = w.props.facing;
      if (f && STEP[f]) {
        for (const dir of [f, OPPOSITE[f]!]) {
          for (const dy of [0, 1]) {
            const n = at(add(add(cell, STEP[dir]!), { x: 0, y: dy, z: 0 }));
            if (solid(n)) out.push(`${name}: ${dir} of the door is ${shortId(n!.want!.id)} — the doorway is blocked`);
          }
        }
      }
    }
    if (WALL_MOUNTED.test(w.id) && w.props.facing && STEP[w.props.facing]) {
      const support = at(add(cell, STEP[OPPOSITE[w.props.facing]!]!));
      if (support && !solid(support)) out.push(`${name}: hangs on ${support.want ? shortId(support.want.id) : "an empty cell"} (${OPPOSITE[w.props.facing]} of it)`);
    } else if (FLOOR_MOUNTED.test(w.id) && !(/_door$/.test(w.id) && w.props.half === "upper")) {
      const below = at(add(cell, STEP.down!));
      if (below && !below.want) out.push(`${name}: stands on an empty cell`);
    }
    // A stair climbs toward its facing. On a slope the next stair (or the ridge) is one up on that
    // side; when it is on the other side instead, the slope is upside down.
    if (/_stairs$/.test(w.id) && w.props.half !== "top" && w.props.facing && STEP[w.props.facing] && w.props.facing !== "up" && w.props.facing !== "down") {
      const up = add(cell, STEP.up!);
      const ahead = at(add(up, STEP[w.props.facing]!));
      const behind = at(add(up, STEP[OPPOSITE[w.props.facing]!]!));
      if (behind?.want && !ahead?.want) {
        out.push(`${name}: the slope rises to the ${OPPOSITE[w.props.facing]} but the stair faces ${w.props.facing} — stairs climb toward their facing, so this slope is upside down (use facing=${OPPOSITE[w.props.facing]})`);
      }
    }
    if (/_bed$/.test(w.id) && w.props.part !== "head" && w.props.facing && STEP[w.props.facing]) {
      const head = at(add(cell, STEP[w.props.facing]!));
      if (head && (!head.want || head.want.id !== w.id)) out.push(`${name}: the cell ${w.props.facing} of it must be the bed's head`);
    }
  }
  for (const s of c.spots) {
    for (const dy of [0, 1]) {
      const cell = at({ x: s.x, y: s.y + dy, z: s.z });
      if (solid(cell)) out.push(`spot ${s.name} @ ${fmtPos(s)}: ${dy ? "head" : "feet"} cell is ${shortId(cell!.want!.id)}`);
    }
  }
  return out;
}

// ----- verify -----------------------------------------------------------------------------------

/** The live block at a position, as perception reports it. */
export type Probe = BlockProbe;

export interface Mismatch {
  cell: Cell;
  kind: "missing" | "wrong_block" | "wrong_state" | "obstructed" | "unloaded";
  actual?: string;
  /** For wrong_state: property → [actual, wanted]. */
  props?: Record<string, [string, string]>;
}

export interface Reach {
  from: string;
  to: string;
  ok: boolean;
  /** When not reachable: the fewest cells that would have to be cleared, if any route exists. */
  blockers?: (Pos & { id: string })[];
}

export interface VerifyReport {
  checked: number;
  ok: number;
  mismatches: Mismatch[];
  reach: Reach[];
  reachNote?: string;
}

function propsOf(state: string | undefined): Record<string, string> {
  if (!state) return {};
  try {
    return parseState(state).props;
  } catch {
    return {};
  }
}

const height = (p: Probe | undefined) => p?.height ?? (p?.air ? 0 : 1);

/** Can a player's body be in this cell? */
function passable(p: Probe | undefined): boolean {
  if (!p || !p.loaded) return false;
  if (p.air) return true;
  return height(p) <= 0.2 || p.climbable === true || (!!p.id && OPENABLE.test(p.id));
}

/** Something to stand on at feet position `p`: a block below, a ladder, or a carpet-like layer in the cell. */
function hasFloor(probe: (p: Pos) => Probe | undefined, p: Pos): boolean {
  const below = probe({ x: p.x, y: p.y - 1, z: p.z });
  const here = probe(p);
  return (!!below && below.loaded && height(below) > 0) || here?.climbable === true || (!!here && height(here) > 0 && height(here) <= 0.2);
}

/** Can a player stand with the feet at `p`? */
export function canStand(probe: (p: Pos) => Probe | undefined, p: Pos): boolean {
  return hasFloor(probe, p) && passable(probe(p)) && passable(probe({ x: p.x, y: p.y + 1, z: p.z }));
}

export function compare(c: Compiled, probe: (p: Pos) => Probe | undefined): { ok: number; mismatches: Mismatch[] } {
  let ok = 0;
  const mismatches: Mismatch[] = [];
  for (const cell of c.cells) {
    const p = probe(cell);
    if (!p || !p.loaded) {
      mismatches.push({ cell, kind: "unloaded" });
      continue;
    }
    if (!cell.want) {
      if (passable(p)) ok++;
      else mismatches.push({ cell, kind: "obstructed", actual: p.state ?? p.id ?? "?" });
      continue;
    }
    if (p.air || !p.id) {
      mismatches.push({ cell, kind: "missing" });
      continue;
    }
    if (p.id !== cell.want.id) {
      mismatches.push({ cell, kind: "wrong_block", actual: p.state ?? p.id });
      continue;
    }
    const actual = propsOf(p.state);
    const wrong: Record<string, [string, string]> = {};
    for (const [k, v] of Object.entries(cell.want.props)) if (actual[k] !== v) wrong[k] = [actual[k] ?? "?", v];
    if (Object.keys(wrong).length) mismatches.push({ cell, kind: "wrong_state", actual: p.state ?? p.id, props: wrong });
    else ok++;
  }
  return { ok, mismatches };
}

/**
 * Walking search over the probed cells. A position is where the feet are: feet and head cells must
 * be passable and there must be something to stand on (or a ladder). Moves go to the four
 * neighbours: level, one up (with head room for the jump) or down a drop of up to three. With
 * `dig`, impassable cells may be entered at a cost of one per cell, which finds the fewest blocks
 * in the way.
 */
export function walk(
  probe: (p: Pos) => Probe | undefined,
  from: Pos,
  to: Pos,
  dig: boolean,
): { ok: boolean; cost: number; dug: Pos[] } | null {
  const cost = (p: Pos): number => {
    const b = probe(p);
    if (passable(b)) return 0;
    if (!dig || !b || !b.loaded) return Infinity;
    return 1;
  };
  const floor = (p: Pos) => hasFloor(probe, p);

  const start = { x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) };
  const goal = keyOf(to);
  const best = new Map<string, number>([[keyOf(start), 0]]);
  const prev = new Map<string, { key: string; dug: Pos[] }>();
  const pos = new Map<string, Pos>([[keyOf(start), start]]);
  const buckets: string[][] = [[keyOf(start)]];
  for (let d = 0; d < buckets.length; d++) {
    const bucket = buckets[d];
    if (!bucket) continue;
    while (bucket.length) {
      const k = bucket.pop()!;
      if (best.get(k) !== d) continue;
      const c = pos.get(k)!;
      if (k === goal) {
        const dug: Pos[] = [];
        for (let at = k; prev.has(at); at = prev.get(at)!.key) dug.push(...prev.get(at)!.dug);
        return { ok: d === 0, cost: d, dug };
      }
      const moves: { to: Pos; through: Pos[]; onto?: Pos }[] = [];
      for (const s of [STEP.north!, STEP.south!, STEP.east!, STEP.west!]) {
        const n = add(c, s);
        moves.push({ to: n, through: [n, add(n, STEP.up!)] });
        moves.push({ to: add(n, STEP.up!), through: [add(c, { x: 0, y: 2, z: 0 }), add(n, STEP.up!), add(n, { x: 0, y: 2, z: 0 })], onto: n });
        for (let drop = 1; drop <= 3; drop++) {
          const through: Pos[] = [];
          for (let y = c.y + 1; y >= c.y - drop; y--) through.push({ x: n.x, y, z: n.z });
          moves.push({ to: { x: n.x, y: c.y - drop, z: n.z }, through });
        }
      }
      if (probe(c)?.climbable) moves.push({ to: add(c, STEP.up!), through: [add(c, { x: 0, y: 2, z: 0 })] });
      if (probe(add(c, STEP.down!))?.climbable) moves.push({ to: add(c, STEP.down!), through: [add(c, STEP.down!)] });
      for (const m of moves) {
        if (!floor(m.to) && !probe(m.to)?.climbable) continue;
        if (!probe(m.to)?.loaded) continue;
        // A jump clears one block, not a fence or a wall.
        if (m.onto && height(probe(m.onto)) > 1) continue;
        let extra = 0;
        const dug: Pos[] = [];
        const seen = new Set<string>();
        for (const t of [...m.through, m.to, add(m.to, STEP.up!)]) {
          const tk = keyOf(t);
          if (seen.has(tk)) continue;
          seen.add(tk);
          const x = cost(t);
          if (x > 0) dug.push(t);
          extra += x;
        }
        if (!Number.isFinite(extra)) continue;
        const nd = d + extra;
        const nk = keyOf(m.to);
        if (nd < (best.get(nk) ?? Infinity)) {
          best.set(nk, nd);
          pos.set(nk, m.to);
          prev.set(nk, { key: k, dug });
          (buckets[nd] ??= []).push(nk);
        }
      }
    }
  }
  return null;
}

/** Every position the verify needs: the plan cells and spots, with a margin to walk around them. */
export function verifyRegion(c: Compiled): { from: Pos; to: Pos; volume: number } {
  const { min, max } = bounds([c.min, c.max, ...c.spots]);
  const from = { x: min.x - 2, y: min.y - 1, z: min.z - 2 };
  const to = { x: max.x + 2, y: max.y + 2, z: max.z + 2 };
  return { from, to, volume: (to.x - from.x + 1) * (to.y - from.y + 1) * (to.z - from.z + 1) };
}

export function reachability(c: Compiled, probe: (p: Pos) => Probe | undefined): Reach[] {
  const [start, ...rest] = c.spots;
  if (!start) return [];
  const out: Reach[] = [];
  for (const s of rest) {
    const free = walk(probe, start, s, false);
    if (free) {
      out.push({ from: start.name, to: s.name, ok: true });
      continue;
    }
    const dug = walk(probe, start, s, true);
    out.push({
      from: start.name,
      to: s.name,
      ok: false,
      ...(dug ? { blockers: dug.dug.map((p) => ({ ...p, id: probe(p)?.state ?? probe(p)?.id ?? "?" })) } : {}),
    });
  }
  return out;
}

const LIST = 14;

function listOf<T>(items: T[], fmt: (t: T) => string): string {
  const shown = items.slice(0, LIST).map(fmt);
  if (items.length > LIST) shown.push(`+${items.length - LIST} more`);
  return shown.join(" · ");
}

export function formatVerify(name: string, c: Compiled, r: VerifyReport): string {
  const by = (k: Mismatch["kind"]) => r.mismatches.filter((m) => m.kind === k);
  const blocks = c.cells.filter((x) => x.want).length;
  const lines = [
    `# verify ${name} · ${blocks} blocks, ${c.cells.length - blocks} must-be-empty cells · ${fmtPos(c.min)} → ${fmtPos(c.max)}`,
    `ok ${r.ok}/${r.checked} · missing ${by("missing").length} · wrong block ${by("wrong_block").length} · wrong state ${by("wrong_state").length} · obstructed ${by("obstructed").length}${by("unloaded").length ? ` · unloaded ${by("unloaded").length}` : ""}`,
  ];
  const ws = by("wrong_state");
  if (ws.length) {
    lines.push(`wrong state: ${listOf(ws, (m) => `${fmtPos(m.cell)} ${shortId(m.cell.want!.id)} ${Object.entries(m.props!).map(([k, [a, w]]) => `${k}=${a} (want ${w})`).join(", ")}`)}`);
  }
  const wb = by("wrong_block");
  if (wb.length) lines.push(`wrong block: ${listOf(wb, (m) => `${fmtPos(m.cell)} ${shortId(m.actual ?? "?")} (want ${shortId(formatState(m.cell.want!))})`)}`);
  const mi = by("missing");
  if (mi.length) lines.push(`missing: ${listOf(mi, (m) => `${fmtPos(m.cell)} ${shortId(formatState(m.cell.want!))}`)}`);
  const ob = by("obstructed");
  if (ob.length) lines.push(`obstructed (must be empty): ${listOf(ob, (m) => `${fmtPos(m.cell)} ${shortId(m.actual ?? "?")}`)}`);
  if (r.reach.length) {
    lines.push(
      `reach from ${r.reach[0]!.from}: ${r.reach
        .map((x) => (x.ok ? `${x.to} ✓` : `${x.to} ✗${x.blockers?.length ? ` blocked by ${x.blockers.map((b) => `${fmtPos(b)} ${shortId(b.id)}`).join(", ")}` : " (no route even through blocks)"}`))
        .join(" · ")}`,
    );
  }
  if (r.reachNote) lines.push(r.reachNote);
  const fixes = r.mismatches.filter((m) => m.kind !== "unloaded").length + r.reach.filter((x) => !x.ok).length;
  lines.push(fixes ? "fix these, then verify again (build_structure fixes the plan cells by itself)" : "the build matches the plan");
  return lines.join("\n");
}

export function formatPlanSummary(name: string, c: Compiled, inventory: Record<string, number>, warnings: string[]): string {
  const need = materials(c);
  const missing: Record<string, number> = {};
  for (const [id, n] of Object.entries(need)) if ((inventory[id] ?? 0) < n) missing[id] = n - (inventory[id] ?? 0);
  const size = `${c.max.x - c.min.x + 1}×${c.max.y - c.min.y + 1}×${c.max.z - c.min.z + 1}`;
  const lines = [
    `# plan ${name} · ${size} (x×y×z) · ${fmtPos(c.min)} → ${fmtPos(c.max)} · ${c.cells.filter((x) => x.want).length} blocks · ${c.cells.filter((x) => !x.want).length} must-be-empty`,
    `materials: ${fmtItems(need, 40) || "none"}`,
    Object.keys(missing).length ? `missing from inventory: ${fmtItems(missing, 40)}` : "inventory has all materials",
  ];
  if (c.spots.length) lines.push(`spots: ${c.spots.map((s) => `${s.name} @ ${fmtPos(s)}`).join(" · ")}`);
  lines.push(warnings.length ? `warnings (${warnings.length}):\n  ${warnings.slice(0, 30).join("\n  ")}${warnings.length > 30 ? `\n  +${warnings.length - 30} more` : ""}` : "no warnings");
  return lines.join("\n");
}
