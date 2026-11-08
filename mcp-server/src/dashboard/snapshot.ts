/**
 * What the agent dashboard shows: one compact snapshot of the agent's situation, read from the game
 * and the agent runtime. Kept separate from the view so it can be tested without a host.
 */
import type { Bridge } from "../agent/body.js";
import { formatJob } from "../agent/jobs.js";
import { isOpen, type Goal } from "../agent/goals.js";
import type { AgentRuntime } from "../agent/runtime.js";
import { markersFor } from "../agent/tools.js";
import { chunkOf, renderMap } from "../agent/worldmap.js";

export interface DashboardSnapshot {
  world: string;
  at: { dim: string; x: number; y: number; z: number };
  health: number;
  maxHealth: number;
  food: number;
  gameMode: string;
  /** The player paused the AI in the game (mods with the takeover key); undefined if not reported. */
  aiPaused?: boolean;
  inventory: { id: string; count: number }[];
  goals: { id: number; title: string; status: string; depth: number; next: boolean }[];
  job: string | null;
  map: { rows: string[]; legend: string; header: string };
  takenAt: number;
}

const MAP_RADIUS = 8;
const MAX_GOALS = 30;

/** Goals depth-first under their parents, open ones and recently closed ones. */
function goalRows(all: Goal[], nextId: number | undefined): DashboardSnapshot["goals"] {
  const children = new Map<number | null, Goal[]>();
  for (const g of all) {
    const list = children.get(g.parentId) ?? [];
    list.push(g);
    children.set(g.parentId, list);
  }
  const rows: DashboardSnapshot["goals"] = [];
  const walk = (parent: number | null, depth: number): void => {
    const list = (children.get(parent) ?? []).sort((a, b) => b.priority - a.priority || a.id - b.id);
    for (const g of list) {
      if (rows.length >= MAX_GOALS) return;
      if (!isOpen(g.status) && depth === 0 && Date.now() - g.updatedAt > 6 * 3600_000) continue;
      rows.push({ id: g.id, title: g.title, status: g.status, depth, next: g.id === nextId });
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

export async function takeSnapshot(rt: AgentRuntime, bridge: Bridge): Promise<DashboardSnapshot> {
  const world = await rt.world();
  const { self, at } = await rt.here();
  const counts = await rt.body.itemCounts().catch(() => ({}) as Record<string, number>);
  const status = await bridge.call<{ aiPaused?: boolean }>("info.status").catch(() => ({}) as { aiPaused?: boolean });
  const next = rt.goals.next(world);
  const job = rt.jobs.running();
  const { cx, cz } = chunkOf(at);
  const chunks = rt.map.around(world, at.dim, cx, cz, MAP_RADIUS);
  const span = MAP_RADIUS * 16 + 16;
  const marks = markersFor(rt.memory.inBox(world, at.dim, at.x - span, at.x + span, at.z - span, at.z + span));
  const lines = renderMap(chunks, at, MAP_RADIUS, marks).split("\n");
  return {
    world,
    at: { dim: at.dim, x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) },
    health: self.health,
    maxHealth: self.maxHealth,
    food: self.food,
    gameMode: self.gameMode,
    ...(typeof status.aiPaused === "boolean" ? { aiPaused: status.aiPaused } : {}),
    inventory: Object.entries(counts)
      .map(([id, count]) => ({ id: id.replace(/^minecraft:/, ""), count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 36),
    goals: goalRows(rt.goals.all(world), next?.goal.id),
    job: job ? formatJob(job) : null,
    map: { header: lines[0] ?? "", rows: lines.slice(1, -1), legend: lines[lines.length - 1] ?? "" },
    takenAt: Date.now(),
  };
}

/** One line for the model, so the tool result is useful in hosts without MCP Apps too. */
export function summarize(s: DashboardSnapshot): string {
  const open = s.goals.filter((g) => isOpen(g.status as Goal["status"])).length;
  return [
    `dashboard · world ${s.world} · ${s.at.x} ${s.at.y} ${s.at.z} ${s.at.dim.replace(/^minecraft:/, "")}`,
    `health ${s.health.toFixed(0)}/${s.maxHealth.toFixed(0)} · food ${s.food} · ${s.gameMode}${s.aiPaused ? " · AI paused by the player" : ""}`,
    `${open} open goals · ${s.job ? s.job.split("\n")[0] : "no job running"}`,
  ].join("\n");
}
