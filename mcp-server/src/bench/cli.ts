#!/usr/bin/env node
/**
 * mcpfabric-bench: reproducible tasks for agents that play through mcpfabric.
 *
 *   mcpfabric-bench list
 *   mcpfabric-bench setup <task> --world <id> [--seed N]     prepare, print the prompt
 *   mcpfabric-bench check <task>                              score the task set up last
 *   mcpfabric-bench run <task...|all> --world <id> --agent "<command>" [--seed N] [--out file.jsonl]
 *
 * `--world` must equal the world id the game reports (session.info), so a setup never runs in a
 * world you did not name: setups clear the inventory and place blocks. `--agent` is any command
 * that plays one task and exits; `{prompt}` in it is replaced by the quoted task prompt, which is
 * also in MCPFABRIC_BENCH_PROMPT. It finds the game like the MCP server does (MCPFABRIC_TOKEN or
 * ~/.mcpfabric/bridge.json).
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Bridge, SessionInfo } from "../agent/body.js";
import { BridgeClient } from "../bridge.js";
import { loadConfig } from "../config.js";
import { defaultDiscoveryPath, Discovery } from "../discovery.js";
import { checkTask, setupTask, type Started } from "./runner.js";
import { TASKS, taskById } from "./tasks.js";

const STATE_FILE = join(process.env.MCPFABRIC_DATA_DIR || join(homedir(), ".mcpfabric"), "bench-state.json");

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function bridgeFromEnv(): Bridge {
  const cfg = loadConfig();
  const discovery = cfg.token ? undefined : new Discovery(defaultDiscoveryPath());
  return new BridgeClient(cfg.bridgeUrl, cfg.token, cfg.timeoutMs, discovery ? () => discovery.read() : undefined);
}

/** Refuses unless the game is in the world the user named. */
async function requireWorld(bridge: Bridge, world: string | undefined): Promise<void> {
  if (!world) throw new Error("--world <id> is required: setups clear the inventory and place blocks. Name the disposable test world (see `mcpfabric-bench world`).");
  const info = await bridge.call<SessionInfo>("session.info");
  if (info.worldId !== world) throw new Error(`the game is in world ${info.worldId}, not ${world}; refusing to set up a task there`);
}

function runAgent(command: string, prompt: string, timeLimitSec: number): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command.replaceAll("{prompt}", JSON.stringify(prompt)), {
      shell: true,
      stdio: "inherit",
      env: { ...process.env, MCPFABRIC_BENCH_PROMPT: prompt },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeLimitSec * 1000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut });
    });
  });
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const bridge = (): Bridge => bridgeFromEnv();
  const seed = Number(arg(rest, "--seed") ?? Date.now() % 100000);
  switch (cmd) {
    case "list":
      for (const t of TASKS) console.log(`${t.id.padEnd(16)} ${t.title} (${t.timeLimitSec}s)`);
      return 0;
    case "world": {
      const info = await bridge().call<SessionInfo>("session.info");
      console.log(info.worldId);
      return 0;
    }
    case "setup": {
      const task = taskById(rest[0] ?? "");
      const b = bridge();
      await requireWorld(b, arg(rest, "--world"));
      const started = await setupTask(b, task, seed);
      mkdirSync(dirname(STATE_FILE), { recursive: true });
      writeFileSync(STATE_FILE, JSON.stringify(started));
      console.log(`${task.id} set up (seed ${seed}). Prompt for the agent:\n\n${task.prompt}\n\nThen: mcpfabric-bench check ${task.id}`);
      return 0;
    }
    case "check": {
      const started = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Started;
      if (rest[0] && rest[0] !== started.task) throw new Error(`the task set up last is ${started.task}, not ${rest[0]}`);
      const r = await checkTask(bridge(), started);
      console.log(`${started.task}: ${r.pass ? "PASS" : "FAIL"} (${r.detail})`);
      return r.pass ? 0 : 1;
    }
    case "run": {
      const agent = arg(rest, "--agent");
      if (!agent) throw new Error('--agent "<command>" is required, e.g. --agent \'claude -p {prompt} --allowedTools mcp__mcpfabric\'');
      const out = arg(rest, "--out");
      const ids = rest.filter((a, i) => !a.startsWith("--") && !(rest[i - 1] ?? "").startsWith("--"));
      const tasks = ids.length === 0 || ids.includes("all") ? TASKS : ids.map(taskById);
      const b = bridge();
      await requireWorld(b, arg(rest, "--world"));
      let passed = 0;
      for (const [i, task] of tasks.entries()) {
        const started = await setupTask(b, task, seed + i);
        const t0 = Date.now();
        const agentRun = await runAgent(agent, task.prompt, task.timeLimitSec);
        const r = await checkTask(b, started).catch((err) => ({ pass: false, detail: `check failed: ${(err as Error).message}` }));
        if (r.pass) passed++;
        const row = { task: task.id, seed: started.seed, pass: r.pass, detail: r.detail, seconds: Math.round((Date.now() - t0) / 1000), timedOut: agentRun.timedOut, exitCode: agentRun.code };
        console.log(`${task.id.padEnd(16)} ${r.pass ? "PASS" : "FAIL"}  ${row.seconds}s${row.timedOut ? " (time limit)" : ""}  ${r.detail}`);
        if (out) appendFileSync(out, JSON.stringify({ ...row, at: new Date().toISOString() }) + "\n");
      }
      console.log(`score: ${passed}/${tasks.length}`);
      return passed === tasks.length ? 0 : 1;
    }
    default:
      console.log("usage: mcpfabric-bench list | world | setup <task> --world <id> [--seed N] | check [task] | run <task...|all> --world <id> --agent \"<command>\" [--seed N] [--out file.jsonl]");
      return cmd ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`mcpfabric-bench: ${(err as Error).message}`);
    process.exit(2);
  },
);
