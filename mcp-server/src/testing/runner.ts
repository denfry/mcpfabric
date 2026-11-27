/**
 * Runs `.mctest.js` files against the running game: lists each file's tests, runs every test in its
 * own sandbox VM (library.ts is the API the file sees), retries failures if asked, and keeps a
 * screenshot and the game's state for each failed attempt.
 *
 * Test files reach the game the way run_script does (ScriptHost: the tool catalogue's bridge
 * methods, checked against their schemas; no supervised methods), so the mod's capability locks
 * apply to tests too. Calls at the top level of a file are refused: a file only registers tests.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import type { Bridge } from "../agent/body.js";
import { HostError, runScript, type ScriptHostApi, type ScriptLimits, type ScriptRun } from "../script/sandbox.js";
import { ScriptHost } from "../script/tools.js";
import { ACT, READ, WRITE, type ToolDef } from "../tools.js";
import { TEST_EPILOGUE, TEST_LIBRARY, TEST_PROTOCOL } from "./library.js";

export const TEST_FILE_SUFFIX = ".mctest.js";

export interface TestError {
  name: string;
  message: string;
  stack?: string;
  /** Steps leading to the failure, outermost first, joined with " > ". */
  step?: string;
  /** Where it failed: beforeAll, beforeEach, test, afterEach, afterAll, load or vm. */
  phase: string;
  code?: string;
}

export interface TestStep {
  name: string;
  depth: number;
  status: "passed" | "failed" | "running" | "interrupted";
  durationMs: number;
}

export interface AttemptResult {
  attempt: number;
  ok: boolean;
  durationMs: number;
  error?: TestError;
  /** An afterEach failure next to a failed test. */
  afterEachError?: TestError;
  steps: TestStep[];
  logs: string[];
  /** Files kept for a failed attempt (screenshot, context), relative to the working directory. */
  artifacts: string[];
}

export interface TestResult {
  file: string;
  name: string;
  status: "passed" | "failed" | "skipped";
  /** Passed only after a failed attempt. */
  flaky: boolean;
  /** Why it was skipped. */
  skipReason?: string;
  durationMs: number;
  attempts: AttemptResult[];
}

export interface RunOptions {
  /** Only tests whose "file > name" matches. */
  grep?: RegExp;
  /** Extra attempts for a failed test. */
  retries?: number;
  /** Default time limit of one test, ms (a test's own `timeout` option wins). */
  timeoutMs?: number;
  /** Time limit of each hook, ms. */
  hookTimeoutMs?: number;
  /** Where failure artifacts go; nothing is written when undefined. */
  artifactsDir?: string;
  /** Take a screenshot when a test fails (needs enableVision). */
  screenshots?: boolean;
  /** Stop after the first failed test; the rest are skipped. */
  bail?: boolean;
  /** Values the files see as `params`. */
  params?: Record<string, string>;
  /** Called as results come in. */
  onResult?: (r: TestResult) => void;
  onFileStart?: (file: string) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
/** Longest a single VM may run, whatever the options say. */
const MAX_VM_MS = 15 * 60_000;
const VM_LIMITS: Partial<ScriptLimits> = {
  // Waits poll the game, so tests make many more calls than a one-off script.
  maxCalls: 50_000,
  maxLogChars: 64_000,
  maxResultChars: 2_000_000,
};

/**
 * Container methods the tests may call besides the tool catalogue, to work menus such as a
 * plugin's shop: the model reaches the same RPC methods through the agent tools, and the mod gates
 * them behind enablePlayerControl like every container call.
 */
export const TEST_ONLY_METHODS: ToolDef[] = [
  {
    name: "container_open",
    method: "container.open",
    title: "Open a container",
    description: "Right-click the container block at x y z; the menu opens once the server answers.",
    inputSchema: { x: z.number(), y: z.number(), z: z.number() },
    annotations: ACT,
  },
  {
    name: "container_state",
    method: "container.state",
    title: "Open menu",
    description: "The open menu: open, type, title, size and its non-empty slots (slot, id, count), the player's inventory left out.",
    inputSchema: {},
    annotations: READ,
    untrusted: true,
  },
  {
    name: "container_click",
    method: "container.click",
    title: "Click a menu slot",
    description: "Click a slot of the open menu like a player: mode pickup (default), quick_move (shift-click), throw or swap; button 0 left, 1 right.",
    inputSchema: {
      slot: z.number().int().min(0),
      mode: z.enum(["pickup", "quick_move", "throw", "swap"]).optional(),
      button: z.number().int().min(0).max(40).optional(),
    },
    annotations: WRITE,
  },
  {
    name: "container_close",
    method: "container.close",
    title: "Close the menu",
    description: "Close the open menu.",
    inputSchema: {},
    annotations: ACT,
  },
];

/** Test files among `paths` (files as given, directories searched), sorted. */
export function findTestFiles(paths: string[]): string[] {
  const out = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(TEST_FILE_SUFFIX)) out.add(resolve(p));
    }
  };
  for (const p of paths) {
    const st = statSync(p);
    if (st.isDirectory()) walk(p, 0);
    else out.add(resolve(p));
  }
  return [...out].sort();
}

interface Listed {
  protocol: number;
  tests: { name: string; skip: boolean; only: boolean; timeoutMs: number }[];
  hooks: { beforeAll: number; afterAll: number; beforeEach: number; afterEach: number };
}

interface RunAnswer {
  protocol: number;
  name: string;
  ok: boolean;
  durationMs: number;
  steps: TestStep[];
  error?: TestError;
  afterEachError?: TestError;
  baseline: number;
}

/** A file could not be loaded or answered something the runner does not understand. */
class FileError extends Error {
  constructor(readonly error: TestError) {
    super(error.message);
  }
}

export class TestRunner {
  private readonly host: ScriptHost;
  private readonly api: ScriptHostApi;
  /** While listing, calls are refused: a file must only register tests at its top level. */
  private readonly listingApi: ScriptHostApi;

  constructor(
    private readonly bridge: Bridge,
    private readonly opts: RunOptions = {},
  ) {
    this.host = new ScriptHost(bridge, undefined, {}, TEST_ONLY_METHODS);
    this.api = this.host.api();
    this.listingApi = {
      helpers: this.api.helpers,
      call: async () => {
        throw new HostError("not_in_test", "the game can only be called inside test(), step() and the hooks, not at the top level of a test file");
      },
    };
  }

  /** Runs every file; results come back in order (and through onResult as they finish). */
  async run(files: string[]): Promise<TestResult[]> {
    const results: TestResult[] = [];
    let bailed = false;
    for (const file of files) {
      this.opts.onFileStart?.(file);
      for (const r of await this.runFile(file, () => bailed)) {
        results.push(r);
        this.opts.onResult?.(r);
        if (r.status === "failed" && this.opts.bail) bailed = true;
      }
    }
    return results;
  }

  /** The tests of one file, without running them. */
  async list(file: string): Promise<Listed> {
    const code = readFileSync(file, "utf8");
    return this.listCode(code, file);
  }

  private async listCode(code: string, file: string): Promise<Listed> {
    const run = await this.vm(code, { mode: "list" }, this.listingApi, 30_000);
    const answer = this.answer(run, file, "load") as Listed;
    if (!Array.isArray(answer.tests)) throw new FileError({ name: "Error", message: "the file did not answer with its tests", phase: "load" });
    return answer;
  }

  private async runFile(file: string, bailed: () => boolean): Promise<TestResult[]> {
    const shown = displayPath(file);
    let code: string;
    let listed: Listed;
    try {
      code = readFileSync(file, "utf8");
      listed = await this.listCode(code, file);
    } catch (err) {
      const error = err instanceof FileError ? err.error : { name: "Error", message: (err as Error).message, phase: "load" };
      return [failedWithoutRunning(shown, "(load)", error)];
    }

    const anyOnly = listed.tests.some((t) => t.only);
    const selected = listed.tests.map((t, index) => {
      let skipReason: string | undefined;
      if (t.skip) skipReason = "test.skip";
      else if (anyOnly && !t.only) skipReason = "another test in the file is test.only";
      else if (this.opts.grep && !this.opts.grep.test(`${shown} > ${t.name}`)) skipReason = "--grep";
      return { ...t, index, skipReason };
    });
    // Tests filtered out by --grep are left out of the report entirely, like other runners do.
    const reported = selected.filter((t) => t.skipReason !== "--grep");
    const toRun = reported.filter((t) => !t.skipReason);

    const results: TestResult[] = [];
    let setupError: TestError | undefined;
    if (toRun.length > 0 && listed.hooks.beforeAll > 0 && !bailed()) {
      setupError = await this.runHook(code, file, "beforeAll", listed.hooks.beforeAll);
    }
    for (const t of reported) {
      if (t.skipReason) {
        results.push(skipped(shown, t.name, t.skipReason));
        continue;
      }
      if (bailed()) {
        results.push(skipped(shown, t.name, "--bail: an earlier test failed"));
        continue;
      }
      if (setupError) {
        results.push(failedWithoutRunning(shown, t.name, { ...setupError, message: `beforeAll failed: ${setupError.message}` }));
        continue;
      }
      const r = await this.runTest(code, file, t.index, t.name, t.timeoutMs);
      results.push(r);
      if (r.status === "failed" && this.opts.bail) {
        // Remaining tests of this file are skipped through bailed() once run() sees this result;
        // within the file, mark it here.
        const rest = reported.slice(reported.indexOf(t) + 1);
        for (const s of rest) results.push(skipped(shown, s.name, s.skipReason ?? "--bail: an earlier test failed"));
        break;
      }
    }
    if (toRun.length > 0 && listed.hooks.afterAll > 0) {
      const error = await this.runHook(code, file, "afterAll", listed.hooks.afterAll);
      if (error) results.push(failedWithoutRunning(shown, "(afterAll)", error));
    }
    return results;
  }

  private async runHook(code: string, file: string, hook: "beforeAll" | "afterAll", count: number): Promise<TestError | undefined> {
    const budget = Math.min(MAX_VM_MS, this.hookTimeout() * count + 10_000);
    try {
      const run = await this.vm(code, { mode: "hook", hook }, this.api, budget);
      const answer = this.answer(run, file, hook) as { ok: boolean; error?: TestError };
      return answer.ok ? undefined : answer.error;
    } catch (err) {
      return err instanceof FileError ? err.error : { name: "Error", message: (err as Error).message, phase: hook };
    } finally {
      await this.host.releaseBody();
    }
  }

  private async runTest(code: string, file: string, index: number, name: string, timeoutMs: number): Promise<TestResult> {
    const shown = displayPath(file);
    const attempts: AttemptResult[] = [];
    const retries = Math.max(0, this.opts.retries ?? 0);
    const t0 = Date.now();
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      const a = await this.attempt(code, file, index, name, timeoutMs, attempt);
      attempts.push(a);
      if (a.ok) break;
    }
    const passed = attempts[attempts.length - 1]!.ok;
    return { file: shown, name, status: passed ? "passed" : "failed", flaky: passed && attempts.length > 1, durationMs: Date.now() - t0, attempts };
  }

  private async attempt(code: string, file: string, index: number, name: string, timeoutMs: number, attempt: number): Promise<AttemptResult> {
    // The VM gets the test's limit plus the hooks' and a margin, so a test that runs out of time
    // still gets its afterEach (the library enforces the test's own limit).
    const budget = Math.min(MAX_VM_MS, timeoutMs + this.hookTimeout() * 2 + 10_000);
    const t0 = Date.now();
    let run: ScriptRun | undefined;
    let result: AttemptResult;
    let baseline: number | undefined;
    try {
      run = await this.vm(code, { mode: "run", index, name, attempt }, this.api, budget);
      const answer = this.answer(run, file, "vm") as RunAnswer;
      if (answer.name !== name || !Array.isArray(answer.steps)) throw new FileError({ name: "Error", message: "the file answered for another test", phase: "vm" });
      baseline = answer.baseline;
      result = {
        attempt,
        ok: answer.ok,
        durationMs: answer.durationMs,
        steps: answer.steps,
        logs: run.logs,
        artifacts: [],
        ...(answer.error ? { error: answer.error } : {}),
        ...(answer.afterEachError ? { afterEachError: answer.afterEachError } : {}),
      };
    } catch (err) {
      const error = err instanceof FileError ? err.error : { name: "Error", message: (err as Error).message, phase: "vm" };
      result = { attempt, ok: false, durationMs: Date.now() - t0, steps: [], logs: run?.logs ?? [], artifacts: [], error };
    }
    if (!result.ok) {
      await this.host.releaseBody();
      if (this.opts.artifactsDir) result.artifacts = await this.keepFailure(file, index, name, result, baseline);
    }
    return result;
  }

  private hookTimeout(): number {
    return this.opts.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  }

  private vm(code: string, ctl: Record<string, unknown>, api: ScriptHostApi, timeoutMs: number): Promise<ScriptRun> {
    const args = {
      __mctest: { ...ctl, timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, hookTimeoutMs: this.hookTimeout(), params: this.opts.params ?? {} },
    };
    return runScript(code + TEST_EPILOGUE, api, { args, library: TEST_LIBRARY, limits: { ...VM_LIMITS, timeoutMs } });
  }

  /** The VM's answer, or a FileError when the file failed to load or answered nonsense. */
  private answer(run: ScriptRun, file: string, phase: string): unknown {
    if (!run.ok) {
      const e = run.error ?? { name: "Error", message: "the run failed" };
      throw new FileError({ name: e.name, message: e.message, phase, ...(e.stack ? { stack: e.stack } : {}), ...(e.code ? { code: e.code } : {}) });
    }
    if (run.resultTruncated) throw new FileError({ name: "Error", message: "the test's report was too large", phase });
    let value: unknown;
    try {
      value = JSON.parse(run.result ?? "null");
    } catch {
      throw new FileError({ name: "Error", message: "the test's report is not JSON", phase });
    }
    if (!value || typeof value !== "object" || (value as { protocol?: unknown }).protocol !== TEST_PROTOCOL) {
      throw new FileError({
        name: "Error",
        message: `${displayPath(file)} did not hand control back to the runner (a top-level return in a test file?)`,
        phase,
      });
    }
    return value;
  }

  /** Screenshot and game state for a failed attempt; returns the files written. */
  private async keepFailure(file: string, index: number, name: string, result: AttemptResult, baseline: number | undefined): Promise<string[]> {
    const shown = displayPath(file);
    const fileDir = slug(shown.endsWith(TEST_FILE_SUFFIX) ? shown.slice(0, -TEST_FILE_SUFFIX.length) : shown);
    const testDir = `${String(index + 1).padStart(2, "0")}-${slug(name)}${result.attempt > 1 ? `-attempt${result.attempt}` : ""}`;
    const dir = join(this.opts.artifactsDir!, fileDir, testDir);
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    const safe = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T | { error: string }> => {
      try {
        return await this.bridge.call<T>(method, params);
      } catch (err) {
        return { error: (err as Error).message };
      }
    };
    const context: Record<string, unknown> = {
      file: displayPath(file),
      test: name,
      attempt: result.attempt,
      error: result.error,
      ...(result.afterEachError ? { afterEachError: result.afterEachError } : {}),
      steps: result.steps,
      logs: result.logs,
      player: await safe("player.getState"),
      screen: await safe("screen.get"),
      // Text in events and chat comes from the game and other players.
      events: await safe("events.getRecent", { limit: 200, ...(baseline !== undefined ? { sinceId: baseline } : {}) }),
    };
    if (this.opts.screenshots !== false) {
      const shot = await safe<{ base64?: string; format?: string }>("vision.screenshot");
      if ("base64" in shot && typeof shot.base64 === "string") {
        const p = join(dir, shot.format === "jpeg" || shot.format === "jpg" ? "screenshot.jpg" : "screenshot.png");
        writeFileSync(p, Buffer.from(shot.base64, "base64"));
        files.push(p);
      } else {
        context.screenshotError = "error" in shot ? shot.error : "the bridge returned no image";
      }
    }
    const ctxPath = join(dir, "context.json");
    writeFileSync(ctxPath, JSON.stringify(context, null, 2) + "\n");
    files.push(ctxPath);
    return files.map((f) => displayPath(f));
  }
}

function skipped(file: string, name: string, reason: string): TestResult {
  return { file, name, status: "skipped", flaky: false, skipReason: reason, durationMs: 0, attempts: [] };
}

function failedWithoutRunning(file: string, name: string, error: TestError): TestResult {
  return { file, name, status: "failed", flaky: false, durationMs: 0, attempts: [{ attempt: 1, ok: false, durationMs: 0, steps: [], logs: [], artifacts: [], error }] };
}

/** A path relative to the working directory when it is inside it, with forward slashes. */
export function displayPath(p: string): string {
  const rel = relative(process.cwd(), p);
  const shown = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : p;
  return shown.split("\\").join("/");
}

/** A file-name-safe version of a test or file name. */
export function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return out || "test";
}
