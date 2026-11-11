/**
 * The mod's RPC methods, answered with Horizon's control commands (`horizon-ctl help` lists them).
 *
 * Every entry returns the shape the mod's Java handler returns (the agent runtime reads several of
 * them, see agent/body.ts), built from Horizon's replies. Horizon's control commands are a preview
 * API without a version of their own (`docs/api/stability.md`), so replies are read defensively:
 * unknown fields are ignored and missing ones left out rather than invented.
 */
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { num, rest, word, type ControlReply } from "./control.js";
import { mapEvent } from "./events.js";

type Params = Record<string, unknown>;
type Vec = [number, number, number];

/** What the methods need from the bridge (HorizonBridge implements it; tests fake it). */
export interface HorizonContext {
  cmd(line: string, timeoutMs?: number): Promise<ControlReply>;
  startAction(name: string, line: string, timeoutMs: number, meta?: Record<string, unknown>, settleMs?: number): Promise<{ meta: Record<string, unknown> }>;
  runAction(name: string, line: string, timeoutMs: number): Promise<ControlReply>;
  action():
    | {
        name: string;
        startedAt: number;
        stopped?: boolean;
        meta: Record<string, unknown>;
        result?: { ok: true; reply: ControlReply } | { ok: false; error: string; kind: string };
      }
    | undefined;
  stopAction(): Promise<boolean>;
  worldKey(): Buffer;
  methods(): string[];
  lastWorld?: { kind: "sp"; folder: string } | { kind: "mp"; address: string };
}

type Handler = (h: HorizonContext, p: Params) => Promise<unknown>;

// ----- helpers ------------------------------------------------------------------------------------

const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);
const NAV_GRACE_S = 10;

/** `minecraft:` added to a bare id; ids are checked to be one word. */
function id(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${what} is required`);
  const v = word(value.trim(), what);
  return v.includes(":") ? v : `minecraft:${v}`;
}

function n(value: unknown, what: string): number {
  const x = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(x)) throw new Error(`${what} must be a number`);
  return x;
}

function int(value: unknown, what: string): number {
  return Math.floor(n(value, what));
}

function pos(p: Params, what = "position"): Vec {
  return [n(p.x, `${what}.x`), n(p.y, `${what}.y`), n(p.z, `${what}.z`)];
}

function blockPos(p: Params, what = "position"): Vec {
  return [int(p.x, `${what}.x`), int(p.y, `${what}.y`), int(p.z, `${what}.z`)];
}

function vecOf(value: unknown, what: string): Params {
  if (!value || typeof value !== "object") throw new Error(`${what} must be an object with x, y and z`);
  return value as Params;
}

function arr3(v: unknown): Vec | undefined {
  return Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === "number") ? [v[0], v[1], v[2]] : undefined;
}

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Horizon refuses `dimension` arguments: everything acts on the player's dimension. */
async function sameDimension(h: HorizonContext, p: Params): Promise<void> {
  if (typeof p.dimension !== "string" || !p.dimension) return;
  const st = await h.cmd("state");
  const want = p.dimension.includes(":") ? p.dimension : `minecraft:${p.dimension}`;
  if (st.dimension !== want) throw new Error(`Horizon reaches only the player's dimension (${String(st.dimension)}), not ${want}`);
}

interface Stack {
  item: string | null;
  count?: number;
  damage?: number;
  max_damage?: number;
  slot?: number;
}

function item(s: unknown): { id: string; count: number; damage?: number; maxDamage?: number } | null {
  const st = s as Stack | null | undefined;
  if (!st || typeof st.item !== "string") return null;
  return {
    id: st.item,
    count: Number(st.count ?? 1),
    ...(st.damage ? { damage: st.damage } : {}),
    ...(st.max_damage ? { maxDamage: st.max_damage } : {}),
  };
}

function slotItems(list: unknown): { slot: number; id: string; count: number; damage?: number; maxDamage?: number }[] {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list as Stack[]) {
    const it = item(s);
    if (it && typeof s.slot === "number") out.push({ slot: s.slot, ...it });
  }
  return out;
}

/** A player name or a target selector for a command (`@all` broadcasts, as the mod's tools say). */
function player(value: unknown): string {
  const v = String(value ?? "@s").trim();
  if (v === "@all") return "@a";
  if (/^@[aeprs]$/.test(v) || /^[A-Za-z0-9_]{1,16}$/.test(v) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return v;
  throw new Error(`player must be a player name, a UUID or @s/@p/@a/@all, got ${JSON.stringify(v)}`);
}

/** Opaque id for a server address: neither the address nor the list entry's name reaches the model. */
function serverId(key: Buffer, address: string): string {
  return "mp:" + createHmac("sha256", key).update(address.trim().toLowerCase()).digest("hex").slice(0, 16);
}

/** Runs a command and returns its chat output; Horizon answers `ok` even when the command failed. */
async function command(h: HorizonContext, text: string): Promise<{ output: string[]; success: boolean }> {
  const line = rest(text.replace(/^\//, "").trim(), "command");
  if (!line) throw new Error("command is required");
  const r = await h.cmd(`command ${line}`);
  const output = Array.isArray(r.chat) ? (r.chat as unknown[]).map(String) : [];
  // The vanilla error lines; a success says what it did.
  const failed = output.some((l) => /^(Unknown or incomplete command|Incorrect argument|Expected |Invalid |No (player|entity|entities) was found|Unknown )/i.test(l) || l.includes("<--[HERE]"));
  return { output, success: !failed };
}

function hostileType(type: string): boolean {
  return HOSTILE.has(type.replace(/^minecraft:/, ""));
}
const HOSTILE = new Set([
  "zombie", "husk", "drowned", "zombie_villager", "skeleton", "stray", "bogged", "wither_skeleton", "creeper", "spider",
  "cave_spider", "enderman", "endermite", "silverfish", "witch", "slime", "magma_cube", "phantom", "pillager", "vindicator",
  "evoker", "ravager", "vex", "guardian", "elder_guardian", "blaze", "ghast", "hoglin", "zoglin", "piglin_brute", "shulker",
  "warden", "breeze", "creaking", "wither", "ender_dragon",
]);
const PASSIVE = new Set([
  "cow", "pig", "sheep", "chicken", "horse", "donkey", "mule", "rabbit", "cat", "wolf", "fox", "goat", "llama", "trader_llama",
  "parrot", "turtle", "panda", "polar_bear", "mooshroom", "ocelot", "axolotl", "frog", "camel", "sniffer", "armadillo", "bee",
  "villager", "wandering_trader", "iron_golem", "snow_golem", "squid", "glow_squid", "dolphin", "cod", "salmon",
  "tropical_fish", "pufferfish", "tadpole", "bat", "strider", "allay", "happy_ghast", "piglin", "zombified_piglin",
]);

interface HEntity {
  id?: number;
  type?: string;
  kind?: string;
  pos?: unknown;
  distance?: number;
  health?: number;
  item?: unknown;
  baby?: boolean;
}

function entityKind(e: HEntity): "item" | "player" | "hostile" | "passive" | "other" {
  const type = String(e.type ?? "");
  if (e.kind === "item") return "item";
  if (type === "minecraft:player") return "player";
  if (hostileType(type)) return "hostile";
  if (PASSIVE.has(type.replace(/^minecraft:/, ""))) return "passive";
  return "other";
}

async function entitiesAround(h: HorizonContext, radius: number): Promise<HEntity[]> {
  const r = await h.cmd(`entities ${num(Math.max(1, Math.min(256, radius)), "radius")}`);
  return Array.isArray(r.entities) ? (r.entities as HEntity[]) : [];
}

function entityOut(e: HEntity) {
  const p = arr3(e.pos) ?? [0, 0, 0];
  const it = item(e.item);
  return {
    uuid: String(e.id),
    type: e.type ?? "unknown",
    kind: entityKind(e),
    x: p[0],
    y: p[1],
    z: p[2],
    distance: Math.round((e.distance ?? 0) * 100) / 100,
    ...(typeof e.health === "number" ? { health: e.health } : {}),
    ...(e.baby ? { baby: true } : {}),
    ...(it ? { item: { id: it.id, count: it.count } } : {}),
  };
}

/** Horizon's numeric entity id from our `uuid` field. */
function entityId(value: unknown): string {
  const s = String(value ?? "");
  if (!/^\d+$/.test(s)) throw new Error("On Horizon an entity's uuid is its numeric id from query_entities");
  return s;
}

async function blockAt(h: HorizonContext, p: Vec) {
  const r = await h.cmd(`block ${p.join(" ")}`);
  const blockId = String(r.block ?? "minecraft:air");
  return {
    x: p[0],
    y: p[1],
    z: p[2],
    loaded: r.loaded !== false,
    id: blockId,
    state: typeof r.state === "string" ? r.state : blockId,
    air: AIR.has(blockId),
    ...(r.sign ? { sign: r.sign } : {}),
  };
}

/** Non-air blocks of a box, split into requests Horizon accepts (at most 32768 positions each). */
async function boxBlocks(h: HorizonContext, lo: Vec, hi: Vec, budget: number): Promise<{ blocks: [number, number, number, string][]; truncated: boolean }> {
  const out: [number, number, number, string][] = [];
  const sx = hi[0] - lo[0] + 1;
  const sz = hi[2] - lo[2] + 1;
  const layer = sx * sz;
  let truncated = false;
  if (layer <= 32768) {
    const step = Math.max(1, Math.floor(32768 / layer));
    let scanned = 0;
    for (let y = lo[1]; y <= hi[1]; y += step) {
      const y2 = Math.min(hi[1], y + step - 1);
      scanned += layer * (y2 - y + 1);
      if (scanned > budget) {
        truncated = true;
        break;
      }
      const r = await h.cmd(`blocks ${lo[0]} ${y} ${lo[2]} ${hi[0]} ${y2} ${hi[2]}`);
      for (const b of (r.blocks as [number, number, number, string][] | undefined) ?? []) out.push(b);
    }
    return { blocks: out, truncated };
  }
  // A wide box: 128x128 columns per request, one layer band at a time.
  let scanned = 0;
  for (let x = lo[0]; x <= hi[0]; x += 128) {
    for (let z = lo[2]; z <= hi[2]; z += 128) {
      const x2 = Math.min(hi[0], x + 127);
      const z2 = Math.min(hi[2], z + 127);
      const part = await boxBlocks(h, [x, lo[1], z], [x2, hi[1], z2], budget - scanned);
      out.push(...part.blocks);
      scanned += (x2 - x + 1) * (z2 - z + 1) * (hi[1] - lo[1] + 1);
      if (part.truncated || scanned > budget) return { blocks: out, truncated: true };
    }
  }
  return { blocks: out, truncated };
}

function baseId(state: string): string {
  const i = state.indexOf("[");
  return i < 0 ? state : state.slice(0, i);
}

/** The best hotbar slot (0-8) to mine `blockId`, by tool family and tier; undefined: the hand. */
function bestSlot(blockId: string, hotbar: { slot: number; id: string }[]): number | undefined {
  const b = blockId.replace(/^minecraft:/, "");
  const family = /(_ore|stone|deepslate|cobble|brick|andesite|diorite|granite|tuff|basalt|blackstone|netherrack|obsidian|terracotta|concrete$|ice$|anvil|furnace|_block$)/.test(b) &&
    !/(dirt|grass|sand|gravel|clay|snow|mud|soul_soil|hay|dried_kelp|honey|slime)/.test(b)
    ? "pickaxe"
    : /(_log|_wood|planks|stem|hyphae|bamboo|chest|barrel|crafting_table|bookshelf|fence|door|sign|ladder)/.test(b)
      ? "axe"
      : /(dirt|grass_block|sand|gravel|clay|snow|mud|farmland|soul_s|podzol|mycelium|rooted_dirt|path)/.test(b)
        ? "shovel"
        : /(leaves|cobweb|wool|vine)/.test(b)
          ? "hoe"
          : undefined;
  if (!family) return undefined;
  const tiers = ["wooden", "golden", "stone", "copper", "iron", "diamond", "netherite"];
  let best: { slot: number; tier: number } | undefined;
  for (const it of hotbar) {
    const m = /^minecraft:([a-z]+)_([a-z]+)$/.exec(it.id);
    if (!m || m[2] !== family) continue;
    const tier = tiers.indexOf(m[1]!);
    if (!best || tier > best.tier) best = { slot: it.slot, tier };
  }
  return best?.slot;
}


/** The container (300+) slots and the player's, from `screen`. */
async function containerScreen(h: HorizonContext) {
  const r = await h.cmd("screen");
  const slots = Array.isArray(r.slots) ? (r.slots as Stack[]) : [];
  const container = slots.filter((s) => typeof s.slot === "number" && s.slot >= 300 && s.slot < 500);
  const title = Array.isArray(r.title) ? (r.title as { text?: string }[]).map((t) => t.text ?? "").join("") : typeof r.title === "string" ? r.title : undefined;
  return { reply: r, slots, container, title };
}

/**
 * The mod numbers a container menu's slots as the vanilla menu does: the container first, then the
 * main inventory (9-35) and the hotbar (0-8). Horizon numbers them 300+, 9-35 and 0-8.
 */
function menuToHorizon(slot: number, size: number): number {
  if (slot < size) return 300 + slot;
  const j = slot - size;
  if (j < 27) return 9 + j;
  if (j < 36) return j - 27;
  throw new Error(`slot ${slot} is outside this menu (0-${size + 35})`);
}

function horizonToMenu(slot: number, size: number): number {
  if (slot >= 300) return slot - 300;
  if (slot >= 9) return size + slot - 9;
  return size + 27 + slot;
}

async function counts(h: HorizonContext): Promise<Record<string, number>> {
  const r = await h.cmd("inventory");
  return (r.counts as Record<string, number> | undefined) ?? {};
}

function screenKind(screen: string, menu: Params | null | undefined): string {
  switch (screen) {
    case "playing":
      return "none";
    case "paused":
      return "pause";
    case "chat":
      return "chat";
    case "container":
    case "station":
    case "inventory":
    case "creative":
      return "container";
    case "dead":
      return "death";
    case "title": {
      const mode = String(menu?.mode ?? "");
      if (mode === "multiplayer") return menu?.disconnected ? "disconnected" : "multiplayer";
      if (mode === "select-world" || mode === "create-world") return "singleplayer";
      return "title";
    }
    default:
      return "other";
  }
}

async function worldIdNow(h: HorizonContext, st: ControlReply): Promise<string | undefined> {
  if (st.screen === "title" || st.world === null || st.world === undefined) return undefined;
  const status = await h.cmd("status");
  const server = status.server as { address?: string } | null | undefined;
  // The integrated server of a singleplayer world answers as "local".
  if (server && typeof server.address === "string" && server.address && server.address !== "local") return serverId(h.worldKey(), server.address);
  // The integrated server's world: the save folder when the name matches one.
  const worlds = ((await h.cmd("worlds")).worlds as { folder: string; name: string }[] | undefined) ?? [];
  const folder = worlds.find((w) => w.folder === st.world)?.folder ?? worlds.find((w) => w.name === st.world)?.folder ?? String(st.world);
  return `sp:${folder}`;
}

// ----- the methods --------------------------------------------------------------------------------

export const HORIZON_METHODS: Record<string, Handler> = {
  // ===== info ==================================================================================
  "info.status": async (h) => {
    const hello = await h.cmd("hello");
    const st = await h.cmd("state");
    const inWorld = st.screen !== "title" && st.world != null;
    return {
      mod: "mcpfabric",
      backend: "horizon",
      loader: "horizon",
      minecraftVersion: "26.3",
      horizon: { release: hello.release, protocol: hello.protocol },
      side: "client",
      aiPaused: false,
      inWorld,
      screen: st.screen,
      ...(inWorld ? { dimension: st.dimension, gameMode: st.gamemode } : {}),
      serverPresent: inWorld,
      integratedServer: inWorld,
      capabilities: capabilities(h, inWorld),
      methods: h.methods(),
      note: "Horizon backend: the tools drive Horizon's agent control socket. The mod's enable* locks do not exist there; the player turns agent control off with Horizon's No AI switch.",
    };
  },
  "info.capabilities": async (h) => {
    const st = await h.cmd("state");
    return { capabilities: capabilities(h, st.screen !== "title" && st.world != null) };
  },

  // ===== session / screens ===================================================================
  "session.info": async (h) => {
    const st = await h.cmd("state");
    const worldId = await worldIdNow(h, st);
    if (!worldId) throw Object.assign(new Error("No world is open (title screen): join_world first."), { code: "no_client_player" });
    return {
      worldId,
      kind: worldId.startsWith("sp:") ? "singleplayer" : "multiplayer",
      ...(worldId.startsWith("sp:") ? { name: String(st.world) } : { name: "server" }),
      dimension: st.dimension,
    };
  },
  "screen.get": async (h) => {
    const st = await h.cmd("state");
    const inWorld = st.screen !== "title" && st.world != null;
    const last = h.lastWorld;
    return {
      inWorld,
      screen: screenKind(String(st.screen), st.menu as Params | null),
      horizonScreen: st.screen,
      paused: st.paused === true,
      canJoin: st.screen === "title",
      ...(last ? { lastWorldId: last.kind === "sp" ? `sp:${last.folder}` : serverId(h.worldKey(), last.address) } : {}),
    };
  },
  "screen.close": async (h) => {
    const st = await h.cmd("state");
    if (st.screen === "title") throw new Error("No world is open: use join_world from the title screen.");
    if (st.screen === "dead") await h.cmd("respawn");
    else if (st.screen === "paused") await h.cmd("resume");
    else if (st.screen !== "playing") await h.cmd("close");
    return { closed: st.screen !== "playing", screen: (await h.cmd("state")).screen };
  },
  "session.worlds": async (h) => {
    const worlds = ((await h.cmd("worlds")).worlds as Params[] | undefined) ?? [];
    let servers: Params[] = [];
    try {
      servers = ((await h.cmd("servers")).servers as Params[] | undefined) ?? [];
    } catch {
      servers = [];
    }
    const last = h.lastWorld;
    return {
      worlds: worlds.map((w) => ({
        worldId: `sp:${String(w.folder)}`,
        name: w.name,
        lastPlayed: w.last_played,
        mode: w.mode,
        joinable: w.corrupted !== true,
      })),
      servers: servers
        .filter((s) => typeof s.address === "string")
        .map((s) => ({ worldId: serverId(h.worldKey(), String(s.address)) })),
      ...(last ? { lastWorldId: last.kind === "sp" ? `sp:${last.folder}` : serverId(h.worldKey(), last.address) } : {}),
    };
  },
  "session.join": async (h, p) => {
    const st = await h.cmd("state");
    if (st.screen !== "title") throw new Error("Already in a world: leave it first (Horizon joins from the title screen).");
    let target = h.lastWorld;
    if (typeof p.worldId === "string" && p.worldId) {
      if (p.worldId.startsWith("sp:")) {
        const folder = p.worldId.slice(3);
        const worlds = ((await h.cmd("worlds")).worlds as { folder: string }[] | undefined) ?? [];
        if (!worlds.some((w) => w.folder === folder)) throw new Error(`No saved world ${p.worldId}: see list_worlds.`);
        target = { kind: "sp", folder };
      } else if (p.worldId.startsWith("mp:")) {
        const servers = ((await h.cmd("servers")).servers as { address?: string }[] | undefined) ?? [];
        const match = servers.find((s) => typeof s.address === "string" && serverId(h.worldKey(), s.address) === p.worldId);
        if (!match?.address) throw new Error(`No server ${p.worldId} in the server list: see list_worlds.`);
        target = { kind: "mp", address: match.address };
      } else {
        throw new Error('worldId must start with "sp:" or "mp:"');
      }
    }
    if (!target) throw new Error("No world was joined in this run yet: pass worldId from list_worlds.");
    if (target.kind === "sp") {
      // A folder name can hold spaces; Horizon's `open` takes one word, so refuse rather than open another world.
      await h.cmd(`open ${word(target.folder, "world folder")}`, 120_000);
    } else {
      await h.cmd(`connect ${word(target.address, "server address")}`, 60_000);
    }
    h.lastWorld = target;
    return { joining: true };
  },

  // ===== local player ==========================================================================
  "player.getState": async (h) => {
    const st = await h.cmd("state");
    const pl = st.player as Params | null;
    if (!pl) throw Object.assign(new Error("No player: the world is not open or the player has not spawned."), { code: "no_client_player" });
    const p = arr3(pl.position) ?? [0, 0, 0];
    const feet = await blockAt(h, [Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2])]).catch(() => undefined);
    const eyes = await blockAt(h, [Math.floor(p[0]), Math.floor(p[1] + 1.6), Math.floor(p[2])]).catch(() => undefined);
    const xp = pl.xp as Params | undefined;
    return {
      x: p[0],
      y: p[1],
      z: p[2],
      yaw: pl.yaw,
      pitch: pl.pitch,
      velocity: arr3(pl.velocity),
      health: pl.health,
      maxHealth: 20,
      absorption: pl.absorption,
      food: pl.food,
      saturation: pl.saturation,
      air: pl.air,
      xpLevel: xp?.level,
      dimension: st.dimension,
      gameMode: st.gamemode,
      onGround: pl.on_ground === true,
      inWater: feet?.id === "minecraft:water" || eyes?.id === "minecraft:water",
      underwater: eyes?.id === "minecraft:water",
      inLava: feet?.id === "minecraft:lava",
      sneaking: pl.sneaking === true,
      sprinting: pl.sprinting === true,
      flying: pl.flying === true,
      selectedSlot: Number(st.selected ?? 1) - 1,
      busy: st.busy ?? null,
    };
  },
  "player.getInventory": async (h) => {
    const r = await h.cmd("inventory");
    const armor = Array.isArray(r.armor) ? (r.armor as (Stack & { part?: string })[]) : [];
    return {
      selectedSlot: Number(r.selected ?? 1) - 1,
      hotbar: slotItems(r.hotbar),
      main: slotItems(r.main),
      armor: armor.filter((a) => typeof a.item === "string").map((a) => ({ slot: a.part, ...item(a)! })),
      offhand: item(r.offhand),
      carried: item(r.carried),
    };
  },
  "player.getEquipment": async (h) => {
    const r = await h.cmd("inventory");
    const armor = Array.isArray(r.armor) ? (r.armor as (Stack & { part?: string })[]) : [];
    const part = (name: string) => item(armor.find((a) => a.part === name));
    return { mainHand: item(r.held), offHand: item(r.offhand), head: part("head"), chest: part("chest"), legs: part("legs"), feet: part("feet") };
  },
  "player.getStatusEffects": async (h) => {
    const r = await h.cmd("effects");
    const active = ((r.effects as { active?: Params[] } | undefined)?.active ?? []).map((e) => ({
      id: String(e.id ?? "").includes(":") ? e.id : `minecraft:${String(e.id)}`,
      amplifier: e.amplifier,
      durationTicks: e.duration,
    }));
    return { effects: active };
  },

  // ===== perception (agent runtime) ============================================================
  "perception.entities": async (h, p) => {
    const radius = Math.max(1, Math.min(64, Number(p.radius ?? 16)));
    const kinds = new Set(Array.isArray(p.kinds) ? (p.kinds as string[]) : []);
    const list = (await entitiesAround(h, radius)).filter((e) => e.kind !== "orb").map(entityOut);
    return { entities: kinds.size ? list.filter((e) => kinds.has(e.kind)) : list };
  },
  "perception.blocks": async (h, p) => {
    if (!Array.isArray(p.positions)) throw new Error("positions must be an array");
    const positions = (p.positions as Params[]).slice(0, 512).map((q) => blockPos(q));
    const hotbar = p.tool === true ? slotItems((await h.cmd("inventory")).hotbar) : [];
    // Pipelined on one connection: Horizon answers them in order.
    const probes = await Promise.all(positions.map((q) => blockAt(h, q)));
    return {
      blocks: probes.map((b) => {
        const slot = p.tool === true && !b.air ? bestSlot(b.id, hotbar) : undefined;
        return { ...b, ...(slot !== undefined ? { bestSlot: slot } : {}) };
      }),
    };
  },
  "perception.scan": async (h, p) => {
    const st = await h.cmd("state");
    const pl = st.player as Params | null;
    if (!pl) throw Object.assign(new Error("No player."), { code: "no_client_player" });
    const me = arr3(pl.position)!;
    // Horizon reads blocks over the socket, so the scan is kept small: 3 chunks around the player.
    const radius = Math.max(0, Math.min(3, Math.floor(Number(p.radius ?? 2))));
    const pcx = Math.floor(me[0]) >> 4;
    const pcz = Math.floor(me[2]) >> 4;
    const y0 = Math.max(-64, Math.floor(me[1]) - 20);
    const y1 = Math.min(319, Math.floor(me[1]) + 12);
    const find = new Set(Array.isArray(p.find) ? (p.find as string[]).map((f) => (f.includes(":") ? f : `minecraft:${f}`)) : []);
    const findLimit = Math.max(1, Math.min(256, Number(p.findLimit ?? 32)));
    const chunks: { cx: number; cz: number; y?: number; counts?: Record<string, number> }[] = [];
    const pois: { x: number; y: number; z: number; id: string; container?: boolean }[] = [];
    const found: { x: number; y: number; z: number; id: string; d: number }[] = [];
    for (let cx = pcx - radius; cx <= pcx + radius; cx++) {
      for (let cz = pcz - radius; cz <= pcz + radius; cz++) {
        const { blocks } = await boxBlocks(h, [cx * 16, y0, cz * 16], [cx * 16 + 15, y1, cz * 16 + 15], 32768);
        const c: Record<string, number> = {};
        let surface: number | undefined;
        for (const [x, y, z, state] of blocks) {
          const bid = baseId(state);
          if (bid.endsWith("_log") || bid.endsWith("_ore") || bid === "minecraft:ancient_debris") c[bid] = (c[bid] ?? 0) + 1;
          if (POI.has(bid) || CONTAINERS.has(bid)) pois.push({ x, y, z, id: bid, ...(CONTAINERS.has(bid) ? { container: true } : {}) });
          if (find.has(bid)) found.push({ x, y, z, id: bid, d: dist([x + 0.5, y + 0.5, z + 0.5], me) });
          if (x === cx * 16 + 8 && z === cz * 16 + 8 && !bid.includes("leaves") && (surface === undefined || y + 1 > surface)) surface = y + 1;
        }
        chunks.push({ cx, cz, ...(surface !== undefined ? { y: surface } : {}), ...(Object.keys(c).length ? { counts: c } : {}) });
      }
    }
    found.sort((a, b) => a.d - b.d);
    return {
      dimension: st.dimension,
      player: { x: me[0], y: me[1], z: me[2] },
      radius,
      yRange: [y0, y1],
      chunks,
      pois,
      ...(find.size ? { found: found.slice(0, findLimit).map(({ d: _d, ...f }) => f), truncated: found.length > findLimit } : {}),
    };
  },

  // ===== world (read) ==========================================================================
  "world.getBlock": async (h, p) => {
    await sameDimension(h, p);
    return blockAt(h, blockPos(p));
  },
  "world.getBlocks": async (h, p) => {
    await sameDimension(h, p);
    const a = blockPos(vecOf(p.from, "from"), "from");
    const b = blockPos(vecOf(p.to, "to"), "to");
    const lo: Vec = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
    const hi: Vec = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
    const volume = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
    // Over the socket every position costs bytes on the game thread: a smaller cap than the mod's.
    const LIMIT = 1_048_576;
    if (volume > LIMIT) throw new Error(`${volume} positions; on Horizon at most ${LIMIT} per call: split the region`);
    const max = Math.max(1, Math.min(200_000, Number(p.maxBlocks ?? 32768)));
    const { blocks } = await boxBlocks(h, lo, hi, LIMIT);
    const out = blocks.slice(0, max).map(([x, y, z, state]) => ({ x, y, z, id: baseId(state), ...(p.includeState === true ? { state } : {}) }));
    return {
      from: { x: lo[0], y: lo[1], z: lo[2] },
      to: { x: hi[0], y: hi[1], z: hi[2] },
      volume,
      count: out.length,
      blocks: out,
      truncated: blocks.length > max,
      ...(p.includeAir === true ? { note: "Horizon lists only non-air blocks: every position not listed is air (or an unloaded chunk)." } : {}),
    };
  },
  "world.findBlocks": async (h, p) => {
    await sameDimension(h, p);
    const center = pos(vecOf(p.center, "center"), "center");
    const radius = Math.max(1, Math.min(128, Number(p.radius ?? 16)));
    const ids = new Set((Array.isArray(p.blockIds) ? (p.blockIds as unknown[]) : []).map((b) => id(b, "blockIds")));
    if (!ids.size) throw new Error("blockIds is required");
    const max = Math.max(1, Math.min(1024, Number(p.maxResults ?? 64)));
    const lo: Vec = [Math.floor(center[0] - radius), Math.max(-64, Math.floor(center[1] - radius)), Math.floor(center[2] - radius)];
    const hi: Vec = [Math.floor(center[0] + radius), Math.min(319, Math.floor(center[1] + radius)), Math.floor(center[2] + radius)];
    const { blocks, truncated } = await boxBlocks(h, lo, hi, 262_144);
    const matches = blocks
      .filter(([, , , s]) => ids.has(baseId(s)))
      .map(([x, y, z, s]) => ({ x, y, z, id: baseId(s), distance: dist([x + 0.5, y + 0.5, z + 0.5], center) }))
      .filter((m) => m.distance <= radius)
      .sort((a, b) => a.distance - b.distance);
    return {
      matches: matches.slice(0, max).map((m) => ({ ...m, distance: Math.round(m.distance * 100) / 100 })),
      count: matches.length,
      truncated: truncated || matches.length > max,
    };
  },
  "world.getTimeAndWeather": async (h) => {
    const st = await h.cmd("state");
    const t = (st.time as Params | undefined) ?? {};
    const w = (st.weather as Params | undefined) ?? {};
    return { dayTime: t.time_of_day, gameTime: t.day_time, day: t.day, raining: w.raining === true, thundering: w.thundering === true, dimension: st.dimension };
  },

  // ===== world (write) =========================================================================
  "world.setBlock": async (h, p) => {
    await sameDimension(h, p);
    const at = blockPos(p);
    const blockId = typeof p.blockId === "string" ? p.blockId.trim() : "";
    if (!blockId) throw new Error("blockId is required");
    const r = await h.cmd(`setblock ${at.join(" ")} ${word(blockId, "blockId")}`);
    // The server's answer: the client sees the change a tick later, so a read now could be stale.
    return { success: r.ok === true, state: typeof r.block === "string" ? r.block : undefined, x: at[0], y: at[1], z: at[2] };
  },
  "world.fill": async (h, p) => {
    await sameDimension(h, p);
    const a = blockPos(vecOf(p.from, "from"), "from");
    const b = blockPos(vecOf(p.to, "to"), "to");
    const blockId = id(p.blockId, "blockId");
    const volume = (Math.abs(a[0] - b[0]) + 1) * (Math.abs(a[1] - b[1]) + 1) * (Math.abs(a[2] - b[2]) + 1);
    if (volume > 32768) throw new Error(`${volume} blocks; fill at most 32768 per call`);
    const r = await h.cmd(`fill ${a.join(" ")} ${b.join(" ")} ${blockId}`);
    return { success: r.ok === true, changed: r.count ?? null, volume };
  },
  "world.setTime": async (h, p) => {
    const t = int(p.time, "time");
    await h.cmd(`time ${num(Math.max(0, Math.min(24000, t)), "time")}`);
    return { success: true, time: t };
  },
  "world.setWeather": async (h, p) => {
    const w = String(p.weather ?? "");
    if (!["clear", "rain", "thunder"].includes(w)) throw new Error("weather must be clear, rain or thunder");
    const d = p.durationSeconds === undefined ? "" : ` ${int(p.durationSeconds, "durationSeconds")}s`;
    return command(h, `weather ${w}${d}`);
  },

  // ===== entities ==============================================================================
  "entities.query": async (h, p) => {
    await sameDimension(h, p);
    const st = await h.cmd("state");
    const me = arr3((st.player as Params | null)?.position);
    if (!me) throw Object.assign(new Error("No player."), { code: "no_client_player" });
    const radius = Math.max(1, Math.min(256, Number(p.radius ?? 32)));
    const center = p.center ? pos(vecOf(p.center, "center"), "center") : me;
    // Horizon measures from the player: widen the search, then measure from the center.
    const list = await entitiesAround(h, Math.min(256, dist(center, me) + radius));
    const types = new Set((Array.isArray(p.types) ? (p.types as string[]) : []).map((t) => (t.includes(":") ? t : `minecraft:${t}`)));
    const max = Math.max(1, Math.min(1000, Number(p.maxResults ?? 100)));
    const out = list
      .filter((e) => e.kind !== "orb")
      .map(entityOut)
      .map((e) => ({ ...e, distance: Math.round(dist([e.x, e.y, e.z], center) * 100) / 100 }))
      .filter((e) => e.distance <= radius)
      .filter((e) => !types.size || types.has(e.type))
      .filter((e) => p.includePlayers !== false || e.kind !== "player")
      .filter((e) => p.onlyLiving !== true || e.kind !== "item")
      .sort((a, b) => a.distance - b.distance);
    return { center: { x: center[0], y: center[1], z: center[2] }, centerSource: p.center ? "given" : "player", count: out.length, entities: out.slice(0, max) };
  },
  "entities.summon": async (h, p) => {
    await sameDimension(h, p);
    const type = id(p.type, "type");
    const at = pos(p);
    if (typeof p.nbt === "string" && p.nbt.trim()) {
      return command(h, `summon ${type} ${at.map((v) => num(v, "position")).join(" ")} ${rest(p.nbt.trim(), "nbt")}`);
    }
    const r = await h.cmd(`summon ${type} ${at.map((v) => num(v, "position")).join(" ")}`);
    return { success: r.ok === true, uuid: r.id !== undefined ? String(r.id) : null };
  },

  // ===== operator (through commands, singleplayer with cheats or an operator) ==================
  "players.give": async (h, p) => {
    const target = player(p.player);
    const count = Math.max(1, Math.min(6400, int(p.count ?? 1, "count")));
    const nbt = typeof p.nbt === "string" && p.nbt.trim() ? rest(p.nbt.trim(), "nbt") : "";
    return command(h, `give ${target} ${id(p.itemId, "itemId")}${nbt} ${count}`);
  },
  "players.applyEffect": async (h, p) => {
    const target = player(p.player);
    const seconds = Math.max(1, int(p.durationSeconds ?? 30, "durationSeconds"));
    const amp = Math.max(0, Math.min(255, int(p.amplifier ?? 0, "amplifier")));
    return command(h, `effect give ${target} ${id(p.effectId, "effectId")} ${seconds} ${amp} ${p.showParticles === false ? "true" : "false"}`);
  },
  "players.teleport": async (h, p) => {
    const target = player(p.player);
    const at = pos(p).map((v) => num(v, "position")).join(" ");
    const facing = p.yaw !== undefined && p.pitch !== undefined ? ` ${num(p.yaw, "yaw")} ${num(p.pitch, "pitch")}` : "";
    if (typeof p.dimension === "string" && p.dimension) return command(h, `execute in ${id(p.dimension, "dimension")} run tp ${target} ${at}${facing}`);
    return command(h, `tp ${target} ${at}${facing}`);
  },
  "players.setGameMode": async (h, p) => {
    const mode = String(p.mode ?? "");
    if (!["survival", "creative", "adventure", "spectator"].includes(mode)) throw new Error("mode must be survival, creative, adventure or spectator");
    return command(h, `gamemode ${mode} ${player(p.player)}`);
  },
  "command.run": async (h, p) => command(h, String(p.command ?? "")),

  // ===== chat / events =========================================================================
  "chat.send": async (h, p) => {
    const message = rest(String(p.message ?? ""), "message").trim();
    if (!message) throw new Error("message is required");
    await h.cmd(`chat ${message}`);
    return { sent: true };
  },
  "chat.getRecent": async (h, p) => {
    const limit = Math.max(1, Math.min(500, int(p.limit ?? 50, "limit")));
    const r = await h.cmd(`chat-log ${limit}`);
    const lines = Array.isArray(r.chat) ? (r.chat as unknown[]).map(String) : [];
    // Horizon sends newest first; the mod's tool returns most recent last.
    return { messages: lines.reverse().map((text) => ({ text, source: "unknown" })), note: "Horizon does not report who wrote a line." };
  },
  "events.getRecent": async (h, p) => {
    const since = p.sinceId === undefined ? 0 : Math.max(0, int(p.sinceId, "sinceId"));
    const limit = Math.max(1, Math.min(500, int(p.limit ?? 50, "limit")));
    const types = new Set(Array.isArray(p.types) ? (p.types as string[]) : []);
    const r = await h.cmd(`events --since ${since}`);
    const events = ((r.events as Params[] | undefined) ?? []).flatMap(mapEvent).filter((e) => !types.size || types.has(e.type));
    return { events: events.slice(-limit), lastId: r.last };
  },

  // ===== control ===============================================================================
  "control.look": async (h, p) => {
    if (p.yaw !== undefined || p.pitch !== undefined) {
      const st = await h.cmd("state");
      const pl = (st.player as Params | null) ?? {};
      const yaw = p.yaw !== undefined ? n(p.yaw, "yaw") : Number(pl.yaw ?? 0);
      const pitch = p.pitch !== undefined ? n(p.pitch, "pitch") : Number(pl.pitch ?? 0);
      await h.cmd(`look ${num(yaw, "yaw")} ${num(Math.max(-90, Math.min(90, pitch)), "pitch")}`);
    }
    if (p.deltaYaw !== undefined || p.deltaPitch !== undefined) {
      await h.cmd(`turn ${num(p.deltaYaw ?? 0, "deltaYaw")} ${num(p.deltaPitch ?? 0, "deltaPitch")}`);
    }
    const pl = ((await h.cmd("state")).player as Params | null) ?? {};
    return { yaw: pl.yaw, pitch: pl.pitch };
  },
  "control.lookAt": async (h, p) => {
    const r = await h.cmd(`look-at ${pos(p).map((v) => num(v, "position")).join(" ")}`);
    return { yaw: r.yaw, pitch: r.pitch };
  },
  "control.jumpOnce": async (h) => {
    const r = await h.runAction("jump", "jump", 10_000);
    return { jumped: r.ok === true };
  },
  "control.setInput": async (h, p) => {
    const keys: [string, string][] = [
      ["forward", "w"],
      ["back", "s"],
      ["left", "a"],
      ["right", "d"],
      ["jump", "space"],
      ["sneak", "shift"],
      ["sprint", "ctrl"],
    ];
    const set: Record<string, boolean> = {};
    for (const [field, key] of keys) {
      if (typeof p[field] !== "boolean") continue;
      await h.cmd(`key ${key} ${p[field] ? "down" : "up"}`);
      set[field] = p[field] as boolean;
    }
    return { input: set };
  },
  "control.stop": async (h) => {
    await h.cmd("release");
    return { stopped: true };
  },
  "control.startUsing": async (h) => {
    await h.cmd("mouse right down");
    return { using: true };
  },
  "control.stopUsing": async (h) => {
    await h.cmd("mouse right up");
    return { using: false };
  },

  // ===== interact ==============================================================================
  "interact.breakBlock": async (h, p) => {
    const at = blockPos(p);
    if (p.mode === "instant") return command(h, `setblock ${at.join(" ")} minecraft:air destroy`);
    // Like the mod's survival mode: start mining and return; poll the block (or job) to see it go.
    try {
      await h.startAction("break", `break ${at.join(" ")} --timeout 30`, 40_000, { pos: at });
    } catch (err) {
      // Refused at once (no visible face, out of reach): like the mod, nothing is mined and the caller
      // sees the block stay; the job moves on instead of failing.
      if ((err as { kind?: string }).kind === "busy" || (err as Error).name === "ControlUnreachableError") throw err;
      return { started: false, reason: (err as Error).message, x: at[0], y: at[1], z: at[2] };
    }
    return { started: true, x: at[0], y: at[1], z: at[2] };
  },
  "interact.stopBreaking": async (h) => {
    const a = h.action();
    if (a && !a.result && a.name === "break") await h.stopAction();
    return { stopped: true };
  },
  "interact.placeBlock": async (h, p) => {
    const at = blockPos(p);
    const face = String(p.face ?? "up");
    const off: Record<string, Vec> = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };
    const d = off[face];
    if (!d) throw new Error("face must be up, down, north, south, east or west");
    const target: Vec = [at[0] + d[0], at[1] + d[1], at[2] + d[2]];
    const r = await h.runAction("place", `place ${target.join(" ")}`, 15_000);
    const placed = (r.block as Params | undefined) ?? {};
    return {
      result: r.changed === true ? "SUCCESS" : "FAIL",
      placed: r.changed === true,
      target: { x: target[0], y: target[1], z: target[2], serverState: placed.state },
      inventoryChange: r.inventory_change,
    };
  },
  "interact.useItem": async (h) => {
    const r = await h.runAction("use-item", "use-item", 15_000);
    return { target: r.block ? "block" : "air", changed: r.changed === true, screen: r.screen, inventoryChange: r.inventory_change };
  },
  "interact.attackEntity": async (h, p) => {
    const r = await h.runAction("attack", `attack ${entityId(p.uuid)}`, 10_000);
    return { ok: r.ok === true, ...r };
  },
  "interact.useEntity": async (h, p) => {
    const r = await h.cmd(`interact-entity ${entityId(p.uuid)}`, 15_000);
    return { result: r.ok === true ? "SUCCESS" : "FAIL", screen: r.screen };
  },
  "interact.dropItem": async (h, p) => {
    const r = await h.cmd(p.wholeStack === true ? "drop all" : "drop");
    return { dropped: item(r.dropped_from), held: item(r.held) };
  },

  // ===== inventory =============================================================================
  "inventory.selectHotbar": async (h, p) => {
    const slot = int(p.slot, "slot");
    if (slot < 0 || slot > 8) throw new Error("slot must be 0-8");
    const r = await h.cmd(`select ${slot + 1}`);
    return { selectedSlot: slot, held: item(r.held) };
  },
  "inventory.swapSlots": async (h, p) => {
    const a = int(p.slotA, "slotA");
    const b = int(p.slotB, "slotB");
    if (a < 0 || a > 35 || b < 0 || b > 35) throw new Error("On Horizon slots 0-35 can be swapped (0-8 hotbar, 9-35 main)");
    const st = await h.cmd("state");
    if (st.screen !== "playing") throw new Error(`the ${String(st.screen)} screen is open; close it first`);
    await h.cmd("open-inventory");
    try {
      await h.cmd(`click-slot ${a}`);
      await h.cmd(`click-slot ${b}`);
      await h.cmd(`click-slot ${a}`);
    } finally {
      await h.cmd("close").catch(() => undefined);
    }
    return { swapped: [a, b] };
  },

  // ===== navigation ============================================================================
  "nav.pathTo": async (h, p) => {
    const target = pos(p);
    const near = Math.max(0.3, Math.min(16, Number(p.reachRadius ?? 1)));
    const timeout = Math.max(1, Math.min(600, int(p.timeoutSeconds ?? 60, "timeoutSeconds")));
    const st = await h.cmd("state");
    const me = arr3((st.player as Params | null)?.position);
    const line = `goto ${target.map((v) => num(v, "position")).join(" ")} --near ${num(near, "reachRadius")} --timeout ${timeout}${p.sprint === true ? " --sprint" : ""}`;
    try {
      await h.startAction("goto", line, (timeout + NAV_GRACE_S) * 1000, { target });
    } catch (err) {
      // The mod answers not_found when no path exists; the jobs try another waypoint on it.
      if (/^no walking path/i.test((err as Error).message)) throw Object.assign(new Error((err as Error).message), { code: "not_found" });
      throw err;
    }
    return {
      // Horizon plans the path inside `goto` and does not report it; the straight distance stands in.
      pathLength: me ? Math.round(dist(me, target)) : 0,
      note: "Horizon's walker walks, jumps one block, drops up to three and swims; it does not dig or pillar.",
    };
  },
  "nav.status": async (h) => {
    const a = h.action();
    if (!a || a.name !== "goto") return { active: false, state: "idle" };
    const target = a.meta.target as Vec | undefined;
    const targetOut = target ? { x: target[0], y: target[1], z: target[2] } : undefined;
    if (!a.result) {
      const st = await h.cmd("state");
      const me = arr3((st.player as Params | null)?.position);
      return {
        active: true,
        state: "walking",
        move: "walk",
        ...(targetOut ? { target: targetOut } : {}),
        ...(me && target ? { distance: Math.round(dist(me, target) * 100) / 100 } : {}),
      };
    }
    if (a.result.ok) return { active: false, state: a.result.reply.arrived === false ? "failed" : "reached", ...(targetOut ? { target: targetOut } : {}), distance: a.result.reply.distance };
    const state = a.stopped ? "stopped" : /timed out|out of time/i.test(a.result.error) ? "timeout" : /stuck/i.test(a.result.error) ? "stuck" : "failed";
    return { active: false, state, error: a.result.error, ...(targetOut ? { target: targetOut } : {}) };
  },
  "nav.stop": async (h) => {
    const a = h.action();
    const running = !!a && !a.result && a.name === "goto";
    if (running) await h.stopAction();
    else await h.cmd("release");
    return { stopped: running };
  },

  // ===== vision ================================================================================
  "vision.screenshot": async (h) => {
    // A folder of our own, so no other process can swap the file between the write and the read.
    const dir = mkdtempSync(join(tmpdir(), "mcpfabric-horizon-"));
    const file = join(dir, "shot.png");
    try {
      const r = await h.cmd(`screenshot ${word(file.replace(/\\/g, "/"), "screenshot path")}`, 30_000);
      const data = readFileSync(file);
      return { base64: data.toString("base64"), format: "png", width: r.width, height: r.height };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  // ===== containers (agent runtime) ============================================================
  "container.open": async (h, p) => {
    const at = blockPos(p);
    await h.runAction("interact", `interact ${at.join(" ")}`, 15_000);
    // The menu opens when the server answers, a tick or two later.
    try {
      await h.cmd("wait-for screen container --timeout 2", 5_000);
    } catch {
      // not a container, or a station: report what is open
    }
    return HORIZON_METHODS["container.state"]!(h, {});
  },
  "container.state": async (h) => {
    const { reply, container, title } = await containerScreen(h);
    const open = reply.screen === "container" && container.length > 0;
    const size = container.length;
    const slots = [] as { slot: number; id: string; count: number }[];
    for (const s of (reply.slots as Stack[] | undefined) ?? []) {
      const it = item(s);
      // Only the container's own slots, as the mod reports them (clicks still reach the player's, see menuToHorizon).
      if (!it || typeof s.slot !== "number" || s.slot < 300 || s.slot >= 500) continue;
      slots.push({ slot: horizonToMenu(s.slot, size), id: it.id, count: it.count });
    }
    slots.sort((a, b) => a.slot - b.slot);
    return { open, containerId: open ? 1 : 0, type: reply.screen, ...(title ? { title } : {}), size, slots };
  },
  "container.click": async (h, p) => {
    const { reply, container } = await containerScreen(h);
    if (reply.screen !== "container") throw new Error("No container is open.");
    const slot = menuToHorizon(int(p.slot, "slot"), container.length);
    const mode = String(p.mode ?? "pickup");
    if (mode === "throw") throw new Error("Horizon cannot throw from a menu slot; drop the item from the hotbar instead.");
    const button = int(p.button ?? 0, "button");
    await h.cmd(`click-slot ${slot}${mode === "quick_move" ? " shift" : button === 1 ? " right" : ""}`);
    return { clicked: true };
  },
  "container.transfer": async (h, p) => {
    const direction = String(p.direction ?? "");
    if (direction !== "take" && direction !== "put") throw new Error("direction must be take or put");
    const want = typeof p.item === "string" && p.item ? id(p.item, "item") : undefined;
    const limit = p.count === undefined ? Infinity : Math.max(1, int(p.count, "count"));
    const { reply, slots } = await containerScreen(h);
    if (reply.screen !== "container") throw new Error("No container is open.");
    const before = await counts(h);
    let moved = 0;
    for (const s of slots) {
      if (moved >= limit) break;
      const it = item(s);
      if (!it || typeof s.slot !== "number") continue;
      const inContainer = s.slot >= 300 && s.slot < 500;
      if ((direction === "take") !== inContainer || (s.slot >= 100 && s.slot < 300) || s.slot >= 500) continue;
      if (want && it.id !== want) continue;
      await h.cmd(`click-slot ${s.slot} shift`);
      moved += it.count;
    }
    const after = await counts(h);
    const diff: Record<string, number> = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const d = (after[k] ?? 0) - (before[k] ?? 0);
      if (d !== 0) diff[k] = direction === "take" ? d : -d;
    }
    return { moved: diff };
  },
  "container.close": async (h) => {
    await h.cmd("close");
    return { closed: true };
  },

  // ===== ui (opt-in) ===========================================================================
  "ui.widgets": async (h) => h.cmd("ui"),
  "ui.click": async (h, p) => {
    const w = p.widget;
    if (typeof w !== "string" && typeof w !== "number") throw new Error("widget is required");
    await h.cmd(`click ${word(String(w), "widget")}`);
    return h.cmd("ui");
  },
};

const POI = new Set([
  "minecraft:crafting_table", "minecraft:smithing_table", "minecraft:stonecutter", "minecraft:grindstone", "minecraft:loom",
  "minecraft:cartography_table", "minecraft:fletching_table", "minecraft:anvil", "minecraft:chipped_anvil",
  "minecraft:damaged_anvil", "minecraft:nether_portal", "minecraft:end_portal_frame", "minecraft:composter",
  "minecraft:enchanting_table", "minecraft:brewing_stand", "minecraft:beacon", "minecraft:bell",
]);
const CONTAINERS = new Set([
  "minecraft:chest", "minecraft:trapped_chest", "minecraft:barrel", "minecraft:furnace", "minecraft:blast_furnace",
  "minecraft:smoker", "minecraft:hopper", "minecraft:dispenser", "minecraft:dropper", "minecraft:ender_chest",
  "minecraft:shulker_box",
]);

/** The mod's capability groups, as Horizon serves them. */
function capabilities(h: HorizonContext, inWorld: boolean): Record<string, boolean> {
  const has = (m: string) => h.methods().includes(m);
  return {
    info: true,
    world_read: inWorld,
    world_write: inWorld,
    entities: inWorld,
    players_admin: inWorld,
    command: inWorld,
    player_local: inWorld,
    control: inWorld,
    interact: inWorld,
    inventory: inWorld,
    nav: inWorld,
    vision: true,
    session: true,
    events: true,
    ui: has("ui.widgets"),
    supervised: false,
  };
}
