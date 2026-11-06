/**
 * The benchmark tasks: each prepares a situation with server commands, gives an agent a goal in
 * plain words, and checks the result through the bridge afterwards. Tasks are relative to where the
 * player stands, so any flat test world works. Every setup rewrites the player's inventory and
 * blocks around them: run it only in a disposable world (the CLI insists).
 */
import type { Bridge, Inventory, SelfState } from "../agent/body.js";

export interface CheckResult {
  pass: boolean;
  detail: string;
}

export interface BenchTask {
  id: string;
  title: string;
  /** What the agent is told. */
  prompt: string;
  /** Server commands, run as the server in order; `@p` is the player. */
  setup: (seed: number) => string[];
  /** Wall-clock budget for the agent. */
  timeLimitSec: number;
  /** `start` is the player before setup, `seed` the one setup used. */
  check: (bridge: Bridge, start: SelfState, seed: number) => Promise<CheckResult>;
}

/** Common start: survival, full health and food, day, clear weather, empty inventory. */
const BASE = [
  "gamemode survival @p",
  "effect clear @p",
  "effect give @p minecraft:instant_health 1 10 true",
  "effect give @p minecraft:saturation 1 20 true",
  "time set day",
  "weather clear",
  "clear @p",
  "kill @e[type=item,distance=..64]",
];

/** A deterministic offset 12..24 blocks away in a direction picked by the seed. */
function offset(seed: number): { dx: number; dz: number } {
  const angle = ((seed * 2654435761) % 360) * (Math.PI / 180);
  const dist = 12 + (seed % 13);
  return { dx: Math.round(Math.cos(angle) * dist), dz: Math.round(Math.sin(angle) * dist) };
}

async function counts(bridge: Bridge): Promise<Record<string, number>> {
  const inv = await bridge.call<Inventory>("player.getInventory");
  const out: Record<string, number> = {};
  for (const it of [...inv.hotbar, ...inv.main]) out[it.id] = (out[it.id] ?? 0) + it.count;
  return out;
}

function have(c: Record<string, number>, match: (id: string) => boolean): number {
  return Object.entries(c)
    .filter(([id]) => match(id))
    .reduce((n, [, v]) => n + v, 0);
}

const isLog = (id: string) => /_(log|stem)$/.test(id) && !id.includes("stripped");

export const TASKS: BenchTask[] = [
  {
    id: "logs",
    title: "Collect logs",
    prompt: "Collect at least 8 logs of any wood. Trees are nearby.",
    setup: (seed) => {
      const { dx, dz } = offset(seed);
      return [...BASE, `execute at @p run place feature minecraft:oak ~${dx} ~ ~${dz}`, `execute at @p run place feature minecraft:birch ~${-dz} ~ ~${dx}`];
    },
    timeLimitSec: 600,
    check: async (bridge) => {
      const n = have(await counts(bridge), isLog);
      return { pass: n >= 8, detail: `${n} logs` };
    },
  },
  {
    id: "crafting_table",
    title: "Craft a crafting table",
    prompt: "Craft a crafting table and keep it in your inventory.",
    setup: () => [...BASE, "give @p minecraft:oak_log 2"],
    timeLimitSec: 300,
    check: async (bridge) => {
      const n = have(await counts(bridge), (id) => id === "minecraft:crafting_table");
      return { pass: n >= 1, detail: `${n} crafting tables` };
    },
  },
  {
    id: "stone_pickaxe",
    title: "Make a stone pickaxe",
    prompt: "Make a stone pickaxe. You have some logs; there is stone in the pile next to you.",
    setup: (seed) => {
      const { dx, dz } = offset(seed);
      const x = Math.sign(dx) * 4;
      const z = Math.sign(dz) * 4;
      return [...BASE, "give @p minecraft:oak_log 3", `execute at @p run fill ~${x} ~ ~${z} ~${x + 1} ~1 ~${z + 1} minecraft:stone`];
    },
    timeLimitSec: 900,
    check: async (bridge) => {
      const n = have(await counts(bridge), (id) => id === "minecraft:stone_pickaxe");
      return { pass: n >= 1, detail: `${n} stone pickaxes` };
    },
  },
  {
    id: "goto_beacon",
    title: "Walk to a marked block",
    prompt: "Somewhere within 30 blocks there is a gold block on a pillar of glowstone. Walk to it and stand next to it.",
    setup: (seed) => {
      const { dx, dz } = offset(seed);
      return [...BASE, `execute at @p run fill ~${dx} ~ ~${dz} ~${dx} ~2 ~${dz} minecraft:glowstone`, `execute at @p run setblock ~${dx} ~3 ~${dz} minecraft:gold_block`];
    },
    timeLimitSec: 300,
    check: async (bridge, start, seed) => {
      const { dx, dz } = offset(seed);
      const self = await bridge.call<SelfState>("player.getState");
      const d = Math.hypot(self.x - (Math.floor(start.x) + dx + 0.5), self.z - (Math.floor(start.z) + dz + 0.5));
      return { pass: d <= 3, detail: `${d.toFixed(1)} blocks from the pillar` };
    },
  },
  {
    id: "chest_loot",
    title: "Find a chest and take its diamond",
    prompt: "A chest within 30 blocks holds a diamond. Find it and take the diamond.",
    setup: (seed) => {
      const { dx, dz } = offset(seed);
      return [...BASE, `execute at @p run setblock ~${dx} ~ ~${dz} minecraft:chest{Items:[{Slot:13b,id:"minecraft:diamond",count:1}]}`];
    },
    timeLimitSec: 400,
    check: async (bridge) => {
      const n = have(await counts(bridge), (id) => id === "minecraft:diamond");
      return { pass: n >= 1, detail: `${n} diamonds` };
    },
  },
  {
    id: "smelt_iron",
    title: "Smelt an iron ingot",
    prompt: "Smelt at least one iron ingot. You have a furnace, fuel and raw iron.",
    setup: () => [...BASE, "give @p minecraft:furnace 1", "give @p minecraft:coal 2", "give @p minecraft:raw_iron 2"],
    timeLimitSec: 600,
    check: async (bridge) => {
      const n = have(await counts(bridge), (id) => id === "minecraft:iron_ingot");
      return { pass: n >= 1, detail: `${n} iron ingots` };
    },
  },
  {
    id: "climb",
    title: "Get up a ledge",
    prompt: "There is a stone platform 4 blocks high right next to you, with no stairs. Get on top of it. You have some dirt.",
    setup: () => [...BASE, "give @p minecraft:dirt 16", "execute at @p run fill ~2 ~ ~-2 ~6 ~3 ~2 minecraft:stone"],
    timeLimitSec: 300,
    check: async (bridge, start) => {
      const self = await bridge.call<SelfState>("player.getState");
      const up = self.y - start.y;
      return { pass: up >= 3.9 && self.x >= Math.floor(start.x) + 2 && self.x <= Math.floor(start.x) + 7, detail: `${up.toFixed(1)} blocks above the start` };
    },
  },
];

export function taskById(id: string): BenchTask {
  const t = TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown task "${id}"; tasks: ${TASKS.map((x) => x.id).join(", ")}`);
  return t;
}
