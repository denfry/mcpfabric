/**
 * Macro skills run as background jobs: long-distance travel, frontier exploration, block collection
 * and recipe-book crafting. Each one loops over bridge primitives with its own feedback checks, so
 * the model issues one call instead of dozens of move/poll/verify round-trips.
 */
import { BridgeError } from "../bridge.js";
import type { BlockProbe, ContainerState, NearbyEntity, Recipe, SelfState } from "./body.js";
import {
  canStand,
  compare,
  compilePlan,
  formatState,
  formatVerify,
  isAttachable,
  isPartner,
  itemFor,
  keyOf,
  materials,
  reachability,
  verifyRegion,
  type Cell,
  type Compiled,
  type Plan,
  type Probe,
  type VerifyReport,
} from "./build.js";
import {
  distance,
  fmtDistance,
  fmtItems,
  fmtPos,
  fullId,
  horizontalDistance,
  shortId,
  type Located,
  type Pos,
} from "./format.js";
import { JobFailure, type JobContext } from "./jobs.js";
import type { Memory } from "./memory.js";
import { poiTitle } from "./observe.js";
import { collectRecipes, formatPlan, plan, type PlanStep } from "./planner.js";
import type { AgentRuntime } from "./runtime.js";
import { chunkOf } from "./worldmap.js";

/** Eye height of a standing player and vanilla survival block reach. */
const EYE = 1.62;
const REACH = 4.5;
/** Horizontal length of one navigation segment; the A* walker has a bounded node budget. */
const SEGMENT = 40;

export const eyeOf = (s: Pos): Pos => ({ x: s.x, y: s.y + EYE, z: s.z });
export const centerOf = (b: Pos): Pos => ({ x: b.x + 0.5, y: b.y + 0.5, z: b.z + 0.5 });
const posKey = (p: Pos) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

function isNotFound(err: unknown): boolean {
  return err instanceof BridgeError && err.code === "not_found";
}

/** Poll `check` every 200 ms until it returns true or `timeoutMs` passes. */
export async function waitFor(ctx: JobContext, check: () => Promise<boolean>, timeoutMs: number, everyMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await ctx.sleep(everyMs);
  }
  return check();
}

/** Stop the job when health is low: the model should retreat or heal instead of pressing on. */
async function vitals(rt: AgentRuntime, minHealth: number): Promise<SelfState> {
  const s = await rt.body.self();
  if (s.health <= minHealth) {
    throw new JobFailure(`stopped for safety: health ${s.health.toFixed(0)}/${s.maxHealth.toFixed(0)} (limit ${minHealth}) — retreat, eat or heal first`);
  }
  return s;
}

/**
 * Self-defence reflex for jobs: hit a hostile mob in melee range (never a creeper — hitting one
 * does not stop the fuse). Mobs otherwise push the bot around until navigation gives up.
 */
export class Guard {
  private last = 0;

  constructor(
    private readonly rt: AgentRuntime,
    private readonly ctx: JobContext,
  ) {}

  /** Attack once if something hostile is close; returns whether it did. Rate-limited to the attack cooldown. */
  async check(): Promise<boolean> {
    if (Date.now() - this.last < 650) return false;
    this.last = Date.now();
    let mobs: NearbyEntity[];
    try {
      mobs = await this.rt.body.entities(5, ["hostile"]);
    } catch {
      return false; // perception unavailable (older mod): no reflex
    }
    const target = mobs.find((m) => m.distance <= 3.2 && !/creeper/.test(m.type));
    if (!target) return false;
    try {
      if ((await this.rt.body.attack(target.uuid)).ok === false) return false; // out of reach
    } catch {
      return false;
    }
    this.ctx.log(`hit ${shortId(target.type)} @ ${fmtPos(target)}`);
    return true;
  }
}

/** Wait for the active navigation to end. Returns its final state, or `stuck` / `timeout`. */
export async function waitNavigation(rt: AgentRuntime, ctx: JobContext, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const guard = new Guard(rt, ctx);
  let best = Infinity;
  let lastProgress = Date.now();
  for (;;) {
    await ctx.sleep(250);
    if (await guard.check()) lastProgress = Date.now(); // fighting back is not being stuck
    const st = await rt.body.navStatus();
    if (!st.active) return st.state;
    if (st.distance !== undefined) {
      if (st.distance < best - 0.3) {
        best = st.distance;
        lastProgress = Date.now();
      } else if (Date.now() - lastProgress > 8000) {
        await rt.body.navStop();
        return "stuck";
      }
    }
    if (Date.now() > deadline) {
      await rt.body.navStop();
      return "timeout";
    }
  }
}

// ----- travel -----------------------------------------------------------------------------------

interface Waypoint {
  pos: Pos;
  reach: number;
}

/**
 * Candidate next waypoints from `self` toward `target`: straight ahead first, then fanned out to
 * either side and shorter, so an obstacle or cliff in the direct line gets routed around.
 * Waypoints snap to the centre of a known chunk, whose measured surface height the walker can use.
 */
function waypoints(rt: AgentRuntime, world: string, self: SelfState, target: Pos, reach: number): Waypoint[] {
  const dx = target.x - self.x;
  const dz = target.z - self.z;
  const h = Math.hypot(dx, dz);
  const out: Waypoint[] = [];
  if (h <= SEGMENT) out.push({ pos: target, reach });
  if (h < 1) return out;
  const ux = dx / h;
  const uz = dz / h;
  const lengths = h <= SEGMENT ? [h * 0.6] : [SEGMENT, SEGMENT * 0.5];
  const seen = new Set(out.map((w) => posKey(w.pos)));
  for (const len of lengths) {
    for (const deg of [0, 35, -35, 70, -70]) {
      const a = (deg * Math.PI) / 180;
      const rx = ux * Math.cos(a) - uz * Math.sin(a);
      const rz = ux * Math.sin(a) + uz * Math.cos(a);
      const px = self.x + rx * len;
      const pz = self.z + rz * len;
      const { cx, cz } = chunkOf({ x: px, z: pz });
      const chunk = rt.map.get(world, self.dimension, cx, cz);
      let pos: Pos = { x: Math.floor(px), y: Math.floor(self.y), z: Math.floor(pz) };
      // Snap to the chunk centre at its measured surface — but only near the current height: from
      // a cave or a valley the surface far above is not a walkable goal.
      const snap = chunk?.y != null && Math.abs(chunk.y - self.y) <= 6;
      if (snap) {
        const centre = { x: cx * 16 + 8, y: chunk!.y!, z: cz * 16 + 8 };
        // Snapping must still make progress toward the target.
        if (horizontalDistance(centre, target) < h - 4) pos = centre;
      }
      const key = posKey(pos);
      if (seen.has(key) || horizontalDistance(pos, target) >= h - 2) continue;
      seen.add(key);
      out.push({ pos, reach: snap ? 4 : 6 });
    }
  }
  return out.slice(0, 10);
}

export interface TravelOptions {
  reach?: number;
  sprint?: boolean;
  minHealth?: number;
}

/** Walk to `target` in segments, re-planning around obstacles. */
export async function travel(rt: AgentRuntime, ctx: JobContext, target: Pos & { dim?: string }, opts: TravelOptions = {}): Promise<string> {
  const reach = opts.reach ?? 2;
  const minHealth = opts.minHealth ?? 6;
  const world = await rt.world();
  const first = await rt.body.self();
  if (target.dim && target.dim !== first.dimension) {
    throw new JobFailure(`target is in ${target.dim} but you are in ${first.dimension}; use a portal first`);
  }
  let failures = 0;
  let segments = 0;
  for (let i = 0; i < 300; i++) {
    ctx.checkpoint();
    const self = await vitals(rt, minHealth);
    const left = distance(self, target);
    ctx.progress(`${fmtDistance(left)} to ${fmtPos(target)}`);
    if (left <= reach + 0.75) return `arrived near ${fmtPos(target)} after ${segments} segment${segments === 1 ? "" : "s"}`;

    let started: Waypoint | undefined;
    const candidates = waypoints(rt, world, self, target, reach);
    for (const wp of candidates) {
      try {
        await rt.body.pathTo(wp.pos, { reachRadius: wp.reach, sprint: opts.sprint ?? false, timeoutSeconds: 45 });
        started = wp;
        break;
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
    if (!started) {
      failures++;
      ctx.log(`no path from ${fmtPos(self)} (${candidates.length} waypoints tried)`);
      if (failures >= 3) {
        throw new JobFailure(
          `no walkable route toward ${fmtPos(target)} from ${fmtPos(self)}: the walker cannot swim, climb or dig — pick another route or clear the way`,
        );
      }
      await ctx.sleep(400);
      continue;
    }
    const end = await waitNavigation(rt, ctx, 50_000);
    segments++;
    if (end === "reached") {
      failures = 0;
    } else {
      failures++;
      ctx.log(`segment toward ${fmtPos(started.pos)} ended: ${end}`);
      if (failures >= 4) throw new JobFailure(`navigation keeps failing near ${fmtPos(self)} (${end})`);
    }
    // Keep the map growing along the way so later waypoints know the terrain height.
    if (segments % 3 === 0) await rt.observe({ radius: 6 }).catch(() => undefined);
  }
  throw new JobFailure(`gave up after ${segments} segments`);
}

// ----- explore ----------------------------------------------------------------------------------

export interface ExploreOptions {
  legs?: number;
  radius?: number;
  minHealth?: number;
}

/** Repeatedly walk to the best frontier chunk, mapping and remembering what comes into view. */
export async function explore(rt: AgentRuntime, ctx: JobContext, opts: ExploreOptions = {}): Promise<string> {
  const legs = opts.legs ?? 4;
  const world = await rt.world();
  const places: Memory[] = [];
  const rare = new Map<string, number>();
  let newChunks = 0;
  let travelled = 0;
  const summary = (why: string) => {
    const lines = [`${why}: ${travelled} leg${travelled === 1 ? "" : "s"}, +${newChunks} chunks mapped`];
    if (places.length > 0) lines.push(`new places: ${places.slice(0, 15).map((m) => `#${m.id} ${m.title} @ ${m.pos ? fmtPos(m.pos) : "?"}`).join(" · ")}`);
    if (rare.size > 0) lines.push(`ores seen: ${fmtItems(Object.fromEntries(rare))}`);
    return lines.join("\n");
  };
  for (let leg = 0; leg < legs; leg++) {
    ctx.checkpoint();
    const { report, at } = await rt.observe({ radius: 8 });
    newChunks += report.newChunks;
    places.push(...report.added);
    for (const [id, n] of Object.entries(report.resources)) if (/_ore$|ancient_debris$/.test(id)) rare.set(id, Math.max(rare.get(id) ?? 0, n));

    const blockedKey = `explore.blocked.${at.dim}`;
    const blocked = new Set(rt.kv.get<string[]>(world, blockedKey) ?? []);
    const headingKey = `explore.heading.${at.dim}`;
    const heading = rt.kv.get<{ dx: number; dz: number }>(world, headingKey);
    const frontier = rt.map
      .frontier(world, at.dim, at, { radius: opts.radius ?? 48, ...(heading ? { heading } : {}) })
      .filter((f) => !blocked.has(`${f.cx},${f.cz}`));
    const next = frontier[0];
    if (!next) return summary(`nothing left to explore within ${opts.radius ?? 48} chunks`);
    rt.kv.set(world, headingKey, { dx: next.target.x - at.x, dz: next.target.z - at.z });
    ctx.progress(`leg ${leg + 1}/${legs} → ${fmtPos(next.target)} (frontier chunk ${next.cx},${next.cz})`);
    try {
      await travel(rt, ctx, next.target, { reach: 4, ...(opts.minHealth !== undefined ? { minHealth: opts.minHealth } : {}) });
      travelled++;
    } catch (err) {
      if (!(err instanceof JobFailure) || err.message.startsWith("stopped for safety")) throw err;
      blocked.add(`${next.cx},${next.cz}`);
      rt.kv.set(world, blockedKey, [...blocked].slice(-500));
      ctx.log(`frontier ${next.cx},${next.cz} unreachable: ${err.message}`);
    }
  }
  const { report } = await rt.observe({ radius: 8 });
  newChunks += report.newChunks;
  places.push(...report.added);
  return summary("done");
}

// ----- collect ----------------------------------------------------------------------------------

export interface CollectOptions {
  blocks: string[];
  count: number;
  radius?: number;
  maxSeconds?: number;
  minHealth?: number;
}

function itemDelta(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, n] of Object.entries(after)) {
    const d = n - (before[id] ?? 0);
    if (d > 0) out[id] = d;
  }
  return out;
}

/** Find, reach and mine `count` blocks of the given types, picking up the drops. */
export async function collect(rt: AgentRuntime, ctx: JobContext, opts: CollectOptions): Promise<string> {
  const ids = opts.blocks.map(fullId);
  const radius = opts.radius ?? 48;
  const minHealth = opts.minHealth ?? 6;
  const deadline = Date.now() + (opts.maxSeconds ?? 300) * 1000;
  const before = await rt.body.itemCounts();
  const skip = new Set<string>();
  let broken = 0;
  let misses = 0;
  const what = ids.map(shortId).join("/");
  const done = async (prefix: string) => {
    const gained = itemDelta(before, await rt.body.itemCounts());
    return `${prefix}: broke ${broken}/${opts.count} ${what}; inventory +${fmtItems(gained) || "nothing"}`;
  };

  const guard = new Guard(rt, ctx);
  const mined: Pos[] = [];
  while (broken < opts.count) {
    ctx.checkpoint();
    if (Date.now() > deadline) throw new JobFailure(await done("time limit reached"));
    await guard.check();
    const self = await vitals(rt, minHealth);
    const eye = eyeOf(self);
    const { scan } = await rt.observe({ radius: Math.max(1, Math.ceil(radius / 16)), find: ids, findLimit: 64 });
    const candidates = (scan.found ?? []).filter((b) => !skip.has(posKey(b)) && distance(b, self) <= radius);
    const exposed = candidates.filter((b) => b.exposed !== false).sort((a, b) => distance(centerOf(a), eye) - distance(centerOf(b), eye));
    const block = exposed[0];
    if (!block) {
      const buried = candidates[0];
      throw new JobFailure(
        buried
          ? await done(`only buried ${what} left within ${radius}m (${candidates.length}, e.g. ${fmtPos(buried)}); the bot does not tunnel yet — dig toward it`)
          : await done(`no ${what} within ${radius}m — explore, or recall where you saw some`),
      );
    }

    const [probe] = await rt.body.blocks([block], { tool: true });
    if (!probe || !probe.loaded || probe.air || !probe.id || !ids.includes(probe.id)) {
      skip.add(posKey(block));
      continue;
    }
    if (probe.canHarvest === false) {
      throw new JobFailure(await done(`${shortId(probe.id)} drops nothing without the right tool, and no hotbar item can harvest it`));
    }
    if (probe.bestSlot !== undefined && probe.bestSlot !== self.selectedSlot) await rt.body.selectHotbar(probe.bestSlot);

    const centre = centerOf(block);
    if (distance(eye, centre) > REACH - 0.3) {
      ctx.progress(`walking to ${shortId(probe.id)} @ ${fmtPos(block)}`);
      try {
        await rt.body.pathTo(block, { reachRadius: 3.5, timeoutSeconds: 40 });
        await waitNavigation(rt, ctx, 45_000);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      const now = eyeOf(await rt.body.self());
      if (distance(now, centre) > REACH - 0.2) {
        skip.add(posKey(block));
        if (++misses > 10) throw new JobFailure(await done("too many unreachable targets"));
        ctx.log(`could not get within reach of ${fmtPos(block)}`);
        continue;
      }
    }

    ctx.progress(`mining ${shortId(probe.id)} @ ${fmtPos(block)} (${broken}/${opts.count})`);
    const carried = totalItems(await rt.body.itemCounts());
    await rt.body.lookAt(centre);
    await rt.body.breakBlock(block);
    const limitMs = Math.min(30_000, 3000 + (probe.hardness ?? 1) * 6000);
    const broke = await waitFor(ctx, async () => {
      await guard.check();
      const [b] = await rt.body.blocks([block]);
      return !!b && (b.air === true || b.id !== probe.id);
    }, limitMs);
    if (!broke) {
      await rt.body.stopBreaking().catch(() => undefined);
      skip.add(posKey(block));
      ctx.log(`${shortId(probe.id)} @ ${fmtPos(block)} did not break in ${Math.round(limitMs / 1000)}s`);
      if (++misses > 10) throw new JobFailure(await done("too many blocks would not break"));
      continue;
    }
    broken++;
    mined.push(block);
    ctx.log(`broke ${shortId(probe.id)} @ ${fmtPos(block)}`);
    if (!(await pickUpDrops(rt, ctx, [block], carried))) ctx.log(`the drop at ${fmtPos(block)} is still on the ground`);
  }
  // Anything that bounced away or fell while other blocks were mined.
  await pickUpDrops(rt, ctx, mined, totalItems(await rt.body.itemCounts()), 8);
  return done("done");
}

/**
 * Walk onto dropped items lying near `spots` until the inventory grows. Items are located through
 * the client's entity list: a drop is never exactly where its block was (it falls, bounces), and
 * the pickup range around the player is barely more than a block.
 */
export async function pickUpDrops(rt: AgentRuntime, ctx: JobContext, spots: Pos[], carried: number, maxWalks = 3): Promise<boolean> {
  let got = false;
  for (let walk = 0; walk < maxWalks; walk++) {
    ctx.checkpoint();
    let drops: NearbyEntity[] = [];
    // A fresh drop appears a tick or two after the block breaks.
    for (let look = 0; look < 3 && drops.length === 0; look++) {
      try {
        drops = (await rt.body.entities(16, ["item"])).filter((e) => spots.some((s) => horizontalDistance(e, centerOf(s)) <= 4 && Math.abs(e.y - s.y) <= 4));
      } catch {
        return got; // perception unavailable (older mod)
      }
      if (drops.length === 0) await ctx.sleep(250);
    }
    const drop = drops[0];
    if (!drop) return got;
    try {
      await rt.body.pathTo({ x: Math.floor(drop.x), y: Math.floor(drop.y + 0.2), z: Math.floor(drop.z) }, { reachRadius: 0.5, timeoutSeconds: 10 });
      await waitNavigation(rt, ctx, 12_000);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    // Fresh drops cannot be picked up for 10 ticks; wait until the inventory actually grows.
    if (await waitFor(ctx, async () => totalItems(await rt.body.itemCounts()) > carried, 1500, 250)) {
      got = true;
      carried = totalItems(await rt.body.itemCounts());
    }
  }
  return got;
}

function totalItems(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

// ----- containers -------------------------------------------------------------------------------

/** Item id → count over the container part of an open menu. */
export function containerItems(st: ContainerState): Record<string, number> {
  const items: Record<string, number> = {};
  for (const s of st.slots) items[s.id] = (items[s.id] ?? 0) + s.count;
  return items;
}

/** Remember (or refresh) what a container at `pos` holds. */
export function recordContainer(rt: AgentRuntime, world: string, pos: Located, blockId: string, st: ContainerState): Memory {
  const items = containerItems(st);
  const body = Object.keys(items).length > 0 ? fmtItems(items, 60) : "empty";
  const existing = rt.memory.findAt(world, pos, ["container", "place"]);
  const data = { ...(existing?.data ?? {}), poi: true, items, size: st.size };
  if (existing) {
    return rt.memory.update(world, existing.id, { body, data, fingerprint: blockId, status: "valid", observed: true })!;
  }
  return rt.memory.add(world, {
    kind: "container",
    title: poiTitle(blockId),
    body,
    tags: ["storage"],
    pos,
    data,
    fingerprint: blockId,
    importance: 0.6,
  });
}

/** Open the container block at `pos` and wait until its menu is open. */
export async function openContainerAt(rt: AgentRuntime, ctx: JobContext, pos: Pos): Promise<{ state: ContainerState; probe: BlockProbe }> {
  const [probe] = await rt.body.blocks([pos]);
  if (!probe?.loaded || !probe.id || probe.air) throw new JobFailure(`no block to open at ${fmtPos(pos)}`);
  const self = await rt.body.self();
  if (distance(eyeOf(self), centerOf(pos)) > REACH) {
    throw new JobFailure(`${shortId(probe.id)} at ${fmtPos(pos)} is out of reach (${fmtDistance(distance(self, pos))}); travel_to it first`);
  }
  const current = await rt.body.containerState();
  if (current.open) await rt.body.containerClose();
  await rt.body.lookAt(centerOf(pos));
  await rt.body.containerOpen(pos);
  let state = current;
  const opened = await waitFor(ctx, async () => {
    state = await rt.body.containerState();
    return state.open;
  }, 3000);
  if (!opened) throw new JobFailure(`${shortId(probe.id)} at ${fmtPos(pos)} did not open (blocked, locked or not a container)`);
  return { state, probe };
}

// ----- craft ------------------------------------------------------------------------------------

const isCraftingMenu = (st: ContainerState) => st.open && (st.type ?? "").endsWith("crafting");
const TABLE = "minecraft:crafting_table";

/** Is there a crafting table within 32 blocks, or one in the inventory to place? */
async function tableAvailable(rt: AgentRuntime): Promise<boolean> {
  if (((await rt.body.itemCounts())[TABLE] ?? 0) > 0) return true;
  const { scan, at } = await rt.observe({ radius: 2, find: [TABLE], findLimit: 4 });
  return (scan.found ?? []).some((b) => distance(b, at) <= 32);
}

/** Put `item` into the selected hotbar slot, moving it from the main inventory if needed. */
export async function holdItem(rt: AgentRuntime, item: string): Promise<void> {
  const inv = await rt.body.inventory();
  const inHotbar = inv.hotbar.find((s) => s.id === item);
  if (inHotbar) {
    await rt.body.selectHotbar(inHotbar.slot);
    return;
  }
  const inMain = inv.main.find((s) => s.id === item);
  if (!inMain) throw new JobFailure(`no ${shortId(item)} in inventory`);
  await rt.body.swapSlots(inMain.slot, inv.selectedSlot);
}

/** Place a block from the inventory on free ground next to the player. */
async function placeNextToPlayer(rt: AgentRuntime, ctx: JobContext, item: string): Promise<Pos> {
  const self = await rt.body.self();
  const fx = Math.floor(self.x);
  const fy = Math.floor(self.y);
  const fz = Math.floor(self.z);
  const spots: Pos[] = [];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [0, 2], [-2, 0], [0, -2]] as const) {
    spots.push({ x: fx + dx, y: fy, z: fz + dz }, { x: fx + dx, y: fy - 1, z: fz + dz });
  }
  const probes = await rt.body.blocks(spots);
  for (let i = 0; i < probes.length; i += 2) {
    const at = probes[i]!;
    const below = probes[i + 1]!;
    if (at.loaded && at.air && below.loaded && !below.air && below.id && !/water|lava/.test(below.id)) {
      await holdItem(rt, item);
      await rt.body.lookAt(centerOf(below));
      await rt.body.placeBlock(below, "up");
      const placed = await waitFor(ctx, async () => {
        const [b] = await rt.body.blocks([at]);
        return b?.id === item;
      }, 2000);
      if (placed) {
        ctx.log(`placed ${shortId(item)} at ${fmtPos(at)}`);
        return { x: at.x, y: at.y, z: at.z };
      }
    }
  }
  throw new JobFailure(`found no free spot next to you to place ${shortId(item)}`);
}

/** Make sure a crafting table menu is open, walking to (or placing) a table if needed. */
async function openCraftingTable(rt: AgentRuntime, ctx: JobContext): Promise<void> {
  const st = await rt.body.containerState();
  if (isCraftingMenu(st)) return;
  if (st.open) await rt.body.containerClose();
  const { scan, at } = await rt.observe({ radius: 2, find: [TABLE], findLimit: 8 });
  let table: Pos | undefined = (scan.found ?? []).sort((a, b) => distance(a, at) - distance(b, at))[0];
  if (!table || distance(table, at) > 32) {
    const counts = await rt.body.itemCounts();
    if (!counts[TABLE]) {
      throw new JobFailure("this recipe needs a crafting table: none within 32 blocks and none in the inventory (craft one from 4 planks)");
    }
    table = await placeNextToPlayer(rt, ctx, TABLE);
  }
  const self = await rt.body.self();
  if (distance(eyeOf(self), centerOf(table)) > REACH - 0.3) await travel(rt, ctx, table, { reach: 3 });
  const { state } = await openContainerAt(rt, ctx, table);
  if (!isCraftingMenu(state)) throw new JobFailure(`the block at ${fmtPos(table)} did not open a crafting menu`);
}

/** Move whatever is left in the crafting grid back into the inventory. */
async function clearGrid(rt: AgentRuntime): Promise<void> {
  const st = await rt.body.containerState();
  const gridSlots = isCraftingMenu(st) ? 9 : 4;
  for (const s of st.slots) {
    if (s.slot >= 1 && s.slot <= gridSlots) await rt.body.containerClick(s.slot, "quick_move");
  }
}

async function runCraftStep(rt: AgentRuntime, ctx: JobContext, step: PlanStep): Promise<void> {
  const id = step.output.id;
  let produced = 0;
  let stalls = 0;
  while (produced < step.output.count) {
    ctx.checkpoint();
    // One craft per placement: "place all" fills the grid with as much as the inventory allows,
    // which would eat ingredients that later steps of the plan still need.
    await rt.body.placeRecipe(step.recipe.ref, false);
    const ready = await waitFor(ctx, async () => {
      const st = await rt.body.containerState();
      return st.slots.some((s) => s.slot === 0 && s.id === id);
    }, 2500);
    const before = (await rt.body.itemCounts())[id] ?? 0;
    if (ready) {
      await rt.body.containerClick(0, "quick_move");
      await ctx.sleep(200);
    }
    const gained = ((await rt.body.itemCounts())[id] ?? 0) - before;
    if (gained > 0) {
      produced += gained;
      stalls = 0;
    } else if (++stalls >= 3) {
      await clearGrid(rt);
      throw new JobFailure(`could not craft ${shortId(id)}: the recipe book would not fill the grid (missing items, locked recipe, or full inventory)`);
    }
  }
  await clearGrid(rt);
  ctx.log(`crafted ${shortId(id)} ×${produced}`);
}

export interface CraftOptions {
  item: string;
  count: number;
}

/** Craft `count` × `item`, including intermediate products, using recipe-book placement. */
export async function craft(rt: AgentRuntime, ctx: JobContext, opts: CraftOptions): Promise<string> {
  const item = fullId(opts.item);
  // Fresh recipes every run: collecting items unlocks recipes while the game is running.
  const cache = new Map<string, Recipe[]>();
  const fetch = (ids: string[]) => rt.body.recipes(ids);
  await collectRecipes(item, fetch, cache);
  const recipesFor = (id: string) => cache.get(id) ?? [];
  const inventory = await rt.body.itemCounts();
  const p = plan(item, opts.count, inventory, recipesFor, { knownOnly: true });
  let steps = p.steps;
  let shown = formatPlan(p);

  // A 3×3 recipe with no crafting table around: make one first from the same materials.
  if (Object.keys(p.gather).length === 0 && p.steps.some((s) => s.needsTable) && !(await tableAvailable(rt))) {
    await collectRecipes(TABLE, fetch, cache);
    const tablePlan = plan(TABLE, 1, inventory, recipesFor, { knownOnly: true });
    const rest = { ...inventory };
    for (const [id, n] of Object.entries(tablePlan.uses)) rest[id] = (rest[id] ?? 0) - n;
    for (const [id, n] of Object.entries(tablePlan.leftovers)) rest[id] = (rest[id] ?? 0) + n;
    const after = plan(item, opts.count, rest, recipesFor, { knownOnly: true });
    shown = `${formatPlan(tablePlan)}\n${formatPlan(after)}`;
    if (Object.keys(tablePlan.gather).length > 0 || Object.keys(after.gather).length > 0) {
      throw new JobFailure(`missing materials (a crafting table is needed too):\n${shown}`);
    }
    steps = [...tablePlan.steps, ...after.steps];
  }
  if (Object.keys(p.gather).length > 0) throw new JobFailure(`missing materials:\n${shown}`);
  const manual = steps.find((s) => s.kind !== "craft");
  if (manual) {
    throw new JobFailure(`the plan needs a ${manual.kind} step for ${shortId(manual.output.id)}, which is not automated yet — do it by hand, then craft again:\n${shown}`);
  }
  if (steps.length === 0) return `already have ${opts.count}× ${shortId(item)}`;

  const st = await rt.body.containerState();
  if (st.open && !isCraftingMenu(st)) await rt.body.containerClose();
  let table = isCraftingMenu(st);
  try {
    for (const [i, step] of steps.entries()) {
      ctx.progress(`step ${i + 1}/${steps.length}: ${shortId(step.output.id)} ×${step.output.count}`);
      if (step.needsTable && !table) {
        await openCraftingTable(rt, ctx);
        table = true;
      }
      await runCraftStep(rt, ctx, step);
    }
  } finally {
    if (table) await rt.body.containerClose().catch(() => undefined);
  }
  const now = (await rt.body.itemCounts())[item] ?? 0;
  return `crafted ${shortId(item)} in ${steps.length} step${steps.length === 1 ? "" : "s"}; you now have ${now}`;
}

// ----- build ------------------------------------------------------------------------------------

/** Most positions one verify probes for walking (cells beyond it are checked, walking is not). */
const VERIFY_VOLUME = 40_000;
const PROBE_BATCH = 512;

async function probeAll(rt: AgentRuntime, positions: Pos[]): Promise<Map<string, Probe>> {
  const out = new Map<string, Probe>();
  for (let i = 0; i < positions.length; i += PROBE_BATCH) {
    for (const b of await rt.body.blocks(positions.slice(i, i + PROBE_BATCH))) out.set(posKey(b), b);
  }
  return out;
}

function box(from: Pos, to: Pos): Pos[] {
  const out: Pos[] = [];
  for (let y = from.y; y <= to.y; y++) for (let x = from.x; x <= to.x; x++) for (let z = from.z; z <= to.z; z++) out.push({ x, y, z });
  return out;
}

/** Compare the plan with the world: every cell, and whether the spots can be walked to. */
export async function verifyPlan(rt: AgentRuntime, plan: Plan, compiled?: Compiled): Promise<{ report: VerifyReport; text: string }> {
  const c = compiled ?? compilePlan(plan);
  const self = await rt.body.self();
  if (self.dimension !== plan.dim) throw new JobFailure(`the plan is in ${plan.dim}, you are in ${self.dimension}`);
  const region = verifyRegion(c);
  const walkable = c.spots.length >= 2 && region.volume <= VERIFY_VOLUME;
  const probes = await probeAll(rt, walkable ? box(region.from, region.to) : c.cells);
  const probe = (p: Pos) => probes.get(posKey(p));
  const { ok, mismatches } = compare(c, probe);
  const report: VerifyReport = {
    checked: c.cells.length,
    ok,
    mismatches,
    reach: walkable ? reachability(c, probe) : [],
    ...(c.spots.length >= 2 && !walkable ? { reachNote: `walking not checked: the area is ${region.volume} positions (limit ${VERIFY_VOLUME})` } : {}),
  };
  return { report, text: formatVerify(plan.name, c, report) };
}

export interface BuildOptions {
  /** place: like a player, from the inventory; set: server-side writes (creative / enableWorldWrite). */
  method?: "place" | "set";
  maxSeconds?: number;
  minHealth?: number;
}

/** Stand where `target` is within reach, and not inside it. */
async function reachFor(rt: AgentRuntime, ctx: JobContext, target: Pos, plan: Compiled, force = false): Promise<boolean> {
  const centre = centerOf(target);
  const self = await rt.body.self();
  const inside = Math.floor(self.x) === target.x && Math.floor(self.z) === target.z && (Math.floor(self.y) === target.y || Math.floor(self.y) + 1 === target.y);
  if (!force && !inside && distance(eyeOf(self), centre) <= REACH - 0.5) return true;
  // A free spot to stand near the target that is not going to be a block of the plan.
  const around = await probeAll(rt, box({ x: target.x - 4, y: target.y - 3, z: target.z - 4 }, { x: target.x + 4, y: target.y + 2, z: target.z + 4 }));
  const probe = (p: Pos) => around.get(posKey(p));
  const spots: Pos[] = [];
  for (const p of around.values()) {
    if (!canStand(probe, p)) continue;
    if (plan.byKey.get(keyOf(p))?.want || plan.byKey.get(keyOf({ x: p.x, y: p.y + 1, z: p.z }))?.want) continue;
    if (p.x === target.x && p.z === target.z && (p.y === target.y || p.y + 1 === target.y)) continue;
    const d = distance(eyeOf({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 }), centre);
    if (d <= REACH - 0.6 && d >= 1.2) spots.push(p);
  }
  spots.sort((a, b) => distance(a, self) - distance(b, self));
  for (const spot of spots.slice(0, 4)) {
    try {
      await rt.body.pathTo(spot, { reachRadius: 0.6, timeoutSeconds: 25 });
    } catch (err) {
      if (isNotFound(err)) continue;
      throw err;
    }
    if ((await waitNavigation(rt, ctx, 30_000)) === "reached") return true;
  }
  ctx.log(`no place to stand within reach of ${fmtPos(target)}`);
  return false;
}

/** Mine one block like a player (best hotbar tool), waiting until it is gone. */
async function mineAt(rt: AgentRuntime, ctx: JobContext, pos: Pos, plan: Compiled): Promise<boolean> {
  const [probe] = await rt.body.blocks([pos], { tool: true });
  if (!probe || !probe.loaded || probe.air) return true;
  if (!(await reachFor(rt, ctx, pos, plan))) return false;
  const self = await rt.body.self();
  if (probe.bestSlot !== undefined && probe.bestSlot !== self.selectedSlot) await rt.body.selectHotbar(probe.bestSlot);
  await rt.body.lookAt(centerOf(pos));
  await rt.body.breakBlock(pos);
  const limitMs = Math.min(30_000, 3000 + (probe.hardness ?? 1) * 6000);
  const gone = await waitFor(ctx, async () => {
    const [b] = await rt.body.blocks([pos]);
    return !!b && (b.air === true || b.id !== probe.id);
  }, limitMs);
  if (!gone) await rt.body.stopBreaking().catch(() => undefined);
  return gone;
}

/** Build (or repair) a plan: clear what is in the way, then place the blocks bottom-up, then verify. */
export async function buildStructure(rt: AgentRuntime, ctx: JobContext, plan: Plan, opts: BuildOptions = {}): Promise<string> {
  const method = opts.method ?? "place";
  const deadline = Date.now() + (opts.maxSeconds ?? 900) * 1000;
  const c = compilePlan(plan);
  const self = await vitals(rt, opts.minHealth ?? 6);
  if (self.dimension !== plan.dim) throw new JobFailure(`the plan is in ${plan.dim}, you are in ${self.dimension}`);

  const probes = await probeAll(rt, c.cells);
  const { mismatches } = compare(c, (p) => probes.get(posKey(p)));
  const unloaded = mismatches.filter((m) => m.kind === "unloaded");
  if (unloaded.length) throw new JobFailure(`${unloaded.length} plan cells are not loaded (e.g. ${fmtPos(unloaded[0]!.cell)}); walk closer first`);
  const clear = mismatches.filter((m) => m.kind !== "missing").map((m) => m.cell);
  // A player's click places both halves of a door or bed; a server write places only the one named.
  const place = mismatches.filter((m) => m.kind !== "obstructed" && (method === "set" || !isPartner(m.cell.want!))).map((m) => m.cell);

  if (method === "place") {
    const need = materials({ ...c, cells: place });
    const have = await rt.body.itemCounts();
    const short = Object.fromEntries(Object.entries(need).filter(([id, n]) => (have[id] ?? 0) < n).map(([id, n]) => [id, n - (have[id] ?? 0)]));
    if (Object.keys(short).length) {
      throw new JobFailure(`missing materials: ${fmtItems(short, 40)}${self.gameMode === "creative" ? " (in creative, method set writes blocks without items)" : ""}`);
    }
  }

  const failures: string[] = [];
  let broke = 0;
  let placed = 0;
  const step = (what: string) => {
    ctx.checkpoint();
    if (Date.now() > deadline) throw new JobFailure(`time limit reached (${what}); placed ${placed}, cleared ${broke}`);
  };
  const guard = new Guard(rt, ctx);

  // Clear from the top down: obstructions, wrong blocks and blocks that face the wrong way.
  const byHeight = (a: Cell, b: Cell) => b.y - a.y || distance(a, self) - distance(b, self);
  for (const cell of [...clear].sort(byHeight)) {
    step("clearing");
    await guard.check();
    ctx.progress(`clearing ${fmtPos(cell)} (${broke}/${clear.length})`);
    if (method === "set") {
      const r = await rt.body.setBlock(cell, "minecraft:air", plan.dim);
      if (r.success || r.state === "minecraft:air") broke++;
      else failures.push(`${fmtPos(cell)}: could not clear (${r.output?.join(" ") ?? "command failed"})`);
    } else if (await mineAt(rt, ctx, cell, c)) {
      broke++;
    } else {
      failures.push(`${fmtPos(cell)}: could not break it`);
    }
  }

  // Solid blocks bottom-up, then what hangs on or stands on them.
  const order = [...place].sort((a, b) => Number(isAttachable(a.want!)) - Number(isAttachable(b.want!)) || a.y - b.y || distance(a, self) - distance(b, self));
  for (const cell of order) {
    step("placing");
    await guard.check();
    await vitals(rt, opts.minHealth ?? 6);
    const state = formatState(cell.want!);
    ctx.progress(`placing ${shortId(state)} @ ${fmtPos(cell)} (${placed}/${order.length})`);
    if (method === "set") {
      const r = await rt.body.setBlock(cell, state, plan.dim);
      if (r.success) placed++;
      else failures.push(`${fmtPos(cell)} ${shortId(state)}: ${r.output?.join(" ") ?? "command failed"}`);
      continue;
    }
    const item = itemFor(cell.want!.id);
    if (!item) {
      failures.push(`${fmtPos(cell)} ${shortId(state)}: no item places it`);
      continue;
    }
    let outcome = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!(await reachFor(rt, ctx, cell, c, attempt > 0))) {
        outcome = "no place to stand within reach";
        break;
      }
      await holdItem(rt, item);
      const r = await rt.body.placeAt(cell, state);
      if (r.placed === false || r.placed === undefined) {
        outcome = `${r.result}${r.reachable?.length ? ` (from here: ${r.reachable.slice(0, 3).map(shortId).join(", ")})` : ""}`;
        continue; // another standing spot may allow it
      }
      outcome = r.matches === false ? `placed as ${shortId(r.serverState ?? "?")}` : "";
      break;
    }
    if (outcome) failures.push(`${fmtPos(cell)} ${shortId(state)}: ${outcome}`);
    else placed++;
  }

  const { text } = await verifyPlan(rt, plan, c);
  const head = `${method === "set" ? "wrote" : "placed"} ${placed}/${order.length} · cleared ${broke}/${clear.length}`;
  const failed = failures.length ? [`failed (${failures.length}): ${failures.slice(0, 12).join(" · ")}${failures.length > 12 ? ` +${failures.length - 12} more` : ""}`] : [];
  return [head, ...failed, text].join("\n");
}
