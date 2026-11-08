/**
 * Code mode: the model writes a short JavaScript program that drives the game through the bridge,
 * instead of dozens of tool round trips, and can keep a program that worked as a skill.
 *
 * Scripts run in the QuickJS sandbox (sandbox.ts) and reach the game only through `mc.call`, which
 * accepts the bridge methods of the tool catalogue (`../tools.ts`) and checks their parameters like
 * the tools do. The mod's capability locks still apply, as every call goes through the bridge.
 * Supervised methods are refused: they belong to the supervisor session (`../supervised.ts`).
 */
import { z } from "zod";

import { BridgeError, BridgeTimeoutError, BridgeUnreachableError } from "../bridge.js";
import type { Bridge } from "../agent/body.js";
import type { AgentRuntime } from "../agent/runtime.js";
import { OVERWRITE, READ, TOOLS, type ToolAnnotations, type ToolDef } from "../tools.js";
import { compileScript, DEFAULT_LIMITS, HostError, MAX_CODE_CHARS, MAX_TIMEOUT_MS, runScript, type ScriptLimits, type ScriptRun } from "./sandbox.js";
import { SKILL_NAME, type ScriptSkill } from "./skills.js";

/** Runs and saves programs that can reach other people (chat, commands, kicks): open world. */
const SCRIPT: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

/** Bridge tools a script may call, by tool name and by RPC method. */
function scriptable(): Map<string, ToolDef> {
  const byName = new Map<string, ToolDef>();
  for (const def of TOOLS) {
    if (def.supervised || def.method.startsWith("supervised.")) continue;
    byName.set(def.name, def);
    byName.set(def.method, def);
  }
  return byName;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Runs scripts for every MCP session of this server process. One script runs at a time, because
 * there is one body; with the agent runtime, a script also holds the body against jobs.
 */
export class ScriptHost {
  private readonly tools = scriptable();
  private readonly schemas = new Map<string, z.ZodType>();
  private active?: { owner: string; abort: AbortController };

  constructor(
    private readonly bridge: Bridge,
    /** Agent runtime, if served: skills and the job lock. */
    readonly runtime?: AgentRuntime,
    private readonly limits: Partial<ScriptLimits> = {},
  ) {}

  /** Helper names exposed as `mc.<name>()`: the tool names. */
  helpers(): string[] {
    return TOOLS.filter((t) => this.tools.get(t.name) === t).map((t) => t.name);
  }

  /** One call from a script: checked against the catalogue and the tool's schema, then forwarded. */
  private async invoke(name: string, params: unknown): Promise<unknown> {
    if (name.startsWith("supervised")) {
      throw new HostError("forbidden", `${name} is not available to scripts: supervised actions need the supervisor session; use the supervised_* tools`);
    }
    const def = this.tools.get(name);
    if (!def) throw new HostError("unknown_method", `unknown method "${name}": use a bridge tool name (get_self) or its method (player.getState)`);
    if (!isPlainObject(params)) throw new HostError("invalid_params", `${def.name} takes an object of parameters`);
    let schema = this.schemas.get(def.name);
    if (!schema) {
      schema = z.object(def.inputSchema);
      this.schemas.set(def.name, schema);
    }
    const parsed = schema.safeParse(params);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; ");
      throw new HostError("invalid_params", `invalid parameters for ${def.name}: ${issues}`);
    }
    try {
      return await this.bridge.call(def.method, parsed.data as Record<string, unknown>);
    } catch (err) {
      if (err instanceof BridgeError) throw new HostError(err.code, err.message, err.data);
      if (err instanceof BridgeTimeoutError) throw new HostError("timeout", err.message);
      if (err instanceof BridgeUnreachableError) throw new HostError("unreachable", err.message);
      throw err;
    }
  }

  /** Runs one program; refuses while another script or a job is running. */
  async run(code: string, opts: { args?: unknown; timeoutMs?: number; owner: string }): Promise<ScriptRun> {
    if (this.active) {
      throw new Error(
        this.active.owner === opts.owner ? "a script of this session is still running; wait for it to finish" : "another MCP session is running a script; wait for it to finish",
      );
    }
    const release = this.runtime?.jobs.hold("A script", opts.owner) ?? (() => {});
    const abort = new AbortController();
    this.active = { owner: opts.owner, abort };
    try {
      const timeoutMs = Math.min(opts.timeoutMs ?? this.limits.timeoutMs ?? DEFAULT_LIMITS.timeoutMs, MAX_TIMEOUT_MS);
      const run = await runScript(
        code,
        { call: (name, params) => this.invoke(name, params), helpers: this.helpers() },
        { args: opts.args, limits: { ...this.limits, timeoutMs }, signal: abort.signal },
      );
      if (!run.ok && run.calls > 0) await this.releaseBody();
      return run;
    } finally {
      this.active = undefined;
      release();
    }
  }

  /** After a failed or stopped script: stop movement, navigation and mining it may have left on. */
  private async releaseBody(): Promise<void> {
    await this.bridge.call("control.stop").catch(() => undefined);
    await this.bridge.call("nav.stop").catch(() => undefined);
    await this.bridge.call("interact.stopBreaking").catch(() => undefined);
  }

  /** Stops the script `owner` started (its MCP session closed). */
  cancelOwnedBy(owner: string): void {
    if (this.active?.owner === owner) this.active.abort.abort();
  }
}

export interface ScriptToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
  /** Needs the agent runtime (its database). */
  needsRuntime?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (host: ScriptHost, owner: string, args: any) => Promise<{ text: string; isError?: boolean }>;
}

/** Compact report of a run, for model context. */
export function formatRun(run: ScriptRun, label = "script"): string {
  const secs = (run.durationMs / 1000).toFixed(1);
  const head = run.ok
    ? `${label} ok · ${run.calls} call${run.calls === 1 ? "" : "s"} · ${secs} s`
    : `${label} failed · ${run.calls} call${run.calls === 1 ? "" : "s"} · ${secs} s`;
  const lines = [head];
  if (run.error) {
    lines.push(`error: ${run.error.name}${run.error.code ? ` [${run.error.code}]` : ""}: ${run.error.message}`);
    if (run.error.stack) lines.push(...run.error.stack.split("\n").map((l) => `  ${l.trim()}`));
  }
  if (run.ok) lines.push(`result: ${run.result ?? "null"}${run.resultTruncated ? " …(truncated)" : ""}`);
  if (run.logs.length > 0) {
    lines.push(`log (${run.logs.length} line${run.logs.length === 1 ? "" : "s"}${run.logTruncated ? ", truncated" : ""}):`);
    for (const l of run.logs) lines.push(`  ${l.replace(/\n/g, "\n  ")}`);
  }
  return lines.join("\n");
}

function formatSkill(s: ScriptSkill): string {
  const last = s.lastOk === undefined ? "never run" : `${s.runs} run${s.runs === 1 ? "" : "s"}, last ${s.lastOk ? "ok" : "failed"}`;
  return `${s.name} — ${s.description || "(no description)"} · ${last}`;
}

const code = z.string().min(1).max(MAX_CODE_CHARS);
const args = z.unknown().optional().describe("JSON value the program reads as mc.args.");
const timeoutSeconds = z
  .number()
  .min(1)
  .max(MAX_TIMEOUT_MS / 1000)
  .optional()
  .describe(`Wall-clock limit of the run in seconds (default ${DEFAULT_LIMITS.timeoutMs / 1000}, max ${MAX_TIMEOUT_MS / 1000}).`);
const skillName = z.string().regex(SKILL_NAME, "lowercase letters, digits and _, starting with a letter, at most 48 characters");

function runtimeOf(host: ScriptHost): AgentRuntime {
  if (!host.runtime) throw new Error("skills need the agent runtime (MCPFABRIC_AGENT)");
  return host.runtime;
}

const RUN_DESCRIPTION =
  "Run a short JavaScript program (ES2023 in a QuickJS sandbox: no Node, files, network or timers) that drives the game through the bridge, instead of many tool calls; top-level await and return work. " +
  "API: `await mc.call(method, params)` calls a bridge tool by name or RPC method (mc.call(\"get_self\") = mc.call(\"player.getState\")); every bridge tool is also a helper with the same parameters and checks, e.g. `await mc.get_self()`, `await mc.find_blocks({ center, radius, blockIds })`, `await mc.break_block({ x, y, z })`. supervised_* tools are refused. " +
  "A failed call throws an Error with `code` (e.g. capability_disabled) and `data`; the mod's enable* locks apply. `mc.log(...)` / console.log record output, `await mc.sleep(ms)` waits, `mc.args` holds args. Return a JSON value as the result. " +
  `Limits: timeoutSeconds (default ${DEFAULT_LIMITS.timeoutMs / 1000}, max ${MAX_TIMEOUT_MS / 1000}), ${DEFAULT_LIMITS.memoryBytes / 1048576} MiB memory, ${DEFAULT_LIMITS.maxCalls} calls, ${DEFAULT_LIMITS.maxSliceMs / 1000} s of computation between awaits, ${DEFAULT_LIMITS.maxLogChars / 1000} KB of log. ` +
  "A failed or stopped script makes no more calls and movement, navigation and mining are released. One script at a time, never during an agent job. Keep a program that worked with save_skill.";

export const SCRIPT_TOOLS: ScriptToolDef[] = [
  {
    name: "run_script",
    title: "Run a script",
    description: RUN_DESCRIPTION,
    inputSchema: { code: code.describe("The program: the body of an async function."), args, timeoutSeconds },
    annotations: SCRIPT,
    run: async (host, owner, a) => {
      const run = await host.run(a.code, { args: a.args, owner, ...(a.timeoutSeconds ? { timeoutMs: a.timeoutSeconds * 1000 } : {}) });
      return { text: formatRun(run), isError: !run.ok };
    },
  },
  {
    name: "save_skill",
    title: "Save a script as a skill",
    description:
      "Keep a program that worked as a named skill of this world, to run again with run_skill and new args (read them from mc.args). The code is compiled first; a syntax error is refused. Saving under an existing name replaces it.",
    inputSchema: {
      name: skillName.describe("Skill name, e.g. mine_vein or build_wall."),
      description: z.string().min(1).max(300).describe("What it does and which args it takes."),
      code: code.describe("The program, as for run_script."),
    },
    annotations: OVERWRITE,
    needsRuntime: true,
    run: async (host, _owner, a) => {
      const rt = runtimeOf(host);
      const err = await compileScript(a.code);
      if (err) return { text: `not saved: ${err.name}: ${err.message}${err.stack ? `\n  ${err.stack.trim()}` : ""}`, isError: true };
      const world = await rt.world();
      const created = rt.skills.save(world, { name: a.name, description: a.description, code: a.code });
      return { text: `${created ? "saved" : "replaced"} skill ${a.name} (${a.code.length} chars)` };
    },
  },
  {
    name: "list_skills",
    title: "List skills",
    description: "The saved skills of this world with their descriptions and last outcome. With name, also that skill's code.",
    inputSchema: { name: skillName.optional().describe("Show this skill's code too.") },
    annotations: READ,
    needsRuntime: true,
    run: async (host, _owner, a) => {
      const rt = runtimeOf(host);
      const world = await rt.world();
      if (a.name) {
        const s = rt.skills.get(world, a.name);
        if (!s) return { text: `no skill ${a.name}`, isError: true };
        return { text: `${formatSkill(s)}\n---\n${s.code}` };
      }
      const all = rt.skills.list(world);
      if (all.length === 0) return { text: "no skills yet; keep a program that worked with save_skill" };
      return { text: [`# skills · ${all.length}`, ...all.map(formatSkill)].join("\n") };
    },
  },
  {
    name: "run_skill",
    title: "Run a skill",
    description: "Run a saved skill with args (its mc.args), under the same sandbox and limits as run_script.",
    inputSchema: { name: skillName, args, timeoutSeconds },
    annotations: SCRIPT,
    needsRuntime: true,
    run: async (host, owner, a) => {
      const rt = runtimeOf(host);
      const world = await rt.world();
      const skill = rt.skills.get(world, a.name);
      if (!skill) return { text: `no skill ${a.name}; list_skills shows the saved ones`, isError: true };
      const run = await host.run(skill.code, { args: a.args, owner, ...(a.timeoutSeconds ? { timeoutMs: a.timeoutSeconds * 1000 } : {}) });
      rt.skills.recordRun(world, skill.name, run.ok);
      return { text: formatRun(run, `skill ${skill.name}`), isError: !run.ok };
    },
  },
  {
    name: "delete_skill",
    title: "Delete a skill",
    description: "Delete a saved skill of this world.",
    inputSchema: { name: skillName },
    annotations: OVERWRITE,
    needsRuntime: true,
    run: async (host, _owner, a) => {
      const rt = runtimeOf(host);
      const world = await rt.world();
      return rt.skills.delete(world, a.name) ? { text: `deleted skill ${a.name}` } : { text: `no skill ${a.name}`, isError: true };
    },
  },
];
