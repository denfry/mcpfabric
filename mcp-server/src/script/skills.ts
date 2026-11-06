/**
 * Script skills: programs that worked once, saved by name per world so the model can run them
 * again with new args instead of writing them anew.
 */
import type { Database } from "../agent/db.js";

export interface ScriptSkill {
  name: string;
  description: string;
  code: string;
  runs: number;
  /** Outcome of the last run, if it ran. */
  lastOk?: boolean;
  lastRunAt?: number;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  name: string;
  description: string;
  code: string;
  runs: number;
  last_ok: number | null;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Skill names are identifiers, so they read well in a list and in `run_skill`. */
export const SKILL_NAME = /^[a-z][a-z0-9_]{0,47}$/;

function toSkill(r: Row): ScriptSkill {
  const s: ScriptSkill = { name: r.name, description: r.description, code: r.code, runs: r.runs, createdAt: r.created_at, updatedAt: r.updated_at };
  if (r.last_ok !== null) s.lastOk = r.last_ok === 1;
  if (r.last_run_at !== null) s.lastRunAt = r.last_run_at;
  return s;
}

/** One line for agent_brief, or undefined when the world has no skills. */
export function briefSkills(skills: ScriptSkill[], max = 12): string | undefined {
  if (skills.length === 0) return undefined;
  const names = skills.slice(0, max).map((s) => s.name);
  return `skills (run_skill): ${names.join(", ")}${skills.length > max ? ` +${skills.length - max} more (list_skills)` : ""}`;
}

export class SkillStore {
  constructor(private readonly db: Database) {}

  /** Saves or replaces a skill; replacing keeps its run count. Returns whether it is new. */
  save(world: string, skill: { name: string; description: string; code: string }, now: number = Date.now()): boolean {
    const existed = this.get(world, skill.name) !== undefined;
    this.db
      .prepare(
        `INSERT INTO script_skills(world, name, description, code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(world, name) DO UPDATE SET description = excluded.description, code = excluded.code, updated_at = excluded.updated_at`,
      )
      .run(world, skill.name, skill.description, skill.code, now, now);
    return !existed;
  }

  get(world: string, name: string): ScriptSkill | undefined {
    const row = this.db.prepare("SELECT * FROM script_skills WHERE world = ? AND name = ?").get(world, name) as Row | undefined;
    return row ? toSkill(row) : undefined;
  }

  /** Most recently used or changed first. */
  list(world: string): ScriptSkill[] {
    const rows = this.db
      .prepare("SELECT * FROM script_skills WHERE world = ? ORDER BY max(updated_at, coalesce(last_run_at, 0)) DESC, name")
      .all(world) as unknown as Row[];
    return rows.map(toSkill);
  }

  delete(world: string, name: string): boolean {
    return Number(this.db.prepare("DELETE FROM script_skills WHERE world = ? AND name = ?").run(world, name).changes) > 0;
  }

  recordRun(world: string, name: string, ok: boolean, now: number = Date.now()): void {
    this.db
      .prepare("UPDATE script_skills SET runs = runs + 1, last_ok = ?, last_run_at = ? WHERE world = ? AND name = ?")
      .run(ok ? 1 : 0, now, world, name);
  }
}
