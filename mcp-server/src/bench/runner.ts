/** Sets a task up and scores it; the CLI and the tests share this. */
import type { Bridge, SelfState } from "../agent/body.js";
import { taskById, type BenchTask, type CheckResult } from "./tasks.js";

export interface Started {
  task: string;
  seed: number;
  /** The player before setup: tasks are placed relative to it. */
  start: SelfState;
  at: number;
}

export async function setupTask(bridge: Bridge, task: BenchTask, seed: number): Promise<Started> {
  const start = await bridge.call<SelfState>("player.getState");
  for (const command of task.setup(seed)) {
    const r = await bridge.call<{ success?: boolean }>("command.run", { command });
    if (r.success === false) throw new Error(`setup command failed: /${command}`);
  }
  return { task: task.id, seed, start, at: Date.now() };
}

export async function checkTask(bridge: Bridge, started: Started): Promise<CheckResult> {
  return taskById(started.task).check(bridge, started.start, started.seed);
}

