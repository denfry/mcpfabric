/**
 * The script sandbox: runs a model-written JavaScript program in QuickJS compiled to WebAssembly.
 *
 * Every run gets a fresh WebAssembly module, so nothing survives from one run to the next and a run
 * that is stopped mid-way is simply dropped. The program sees only what this file puts in its
 * global scope (`mc`, `console`): no Node, no file system, no network, no timers. Host calls are
 * promises inside the VM; the host settles them and then runs the VM's pending jobs.
 *
 * The program is wrapped in an async function, so it can `await` and `return` at the top level.
 */
import { newQuickJSWASMModule, type QuickJSDeferredPromise, type QuickJSHandle } from "quickjs-emscripten";

export interface ScriptLimits {
  /** Wall-clock budget of the whole run. */
  timeoutMs: number;
  /** Heap of the VM. */
  memoryBytes: number;
  /** Host calls (`mc.call` and the helpers) per run. */
  maxCalls: number;
  /** Total characters of `mc.log` output kept. */
  maxLogChars: number;
  /** Characters of the JSON result kept. */
  maxResultChars: number;
  /**
   * Longest stretch of computation without awaiting the host. The VM runs on the server's event
   * loop, so a busy loop would stall every other request until it is interrupted.
   */
  maxSliceMs: number;
}

export const DEFAULT_LIMITS: ScriptLimits = {
  timeoutMs: 60_000,
  memoryBytes: 64 * 1024 * 1024,
  maxCalls: 2000,
  maxLogChars: 16_000,
  maxResultChars: 32_000,
  maxSliceMs: 5_000,
};

/** Longest timeout a caller may ask for. */
export const MAX_TIMEOUT_MS = 300_000;
/** Largest program accepted, in characters. */
export const MAX_CODE_CHARS = 64_000;
/** Largest host result handed to the VM, in characters of JSON. */
const MAX_HOST_RESULT_CHARS = 8_000_000;

/** An error the host reports to the script; `code` becomes the Error's `code` property. */
export class HostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface ScriptHostApi {
  /** Performs one call; `params` is a parsed JSON value. Throw a {@link HostError} to fail it. */
  call(name: string, params: unknown): Promise<unknown>;
  /** Names exposed as helpers: `mc.<name>(params)` = `mc.call("<name>", params)`. */
  helpers: string[];
}

export interface ScriptError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
}

export interface ScriptRun {
  ok: boolean;
  /** JSON of the returned value (`null` for undefined), possibly cut at maxResultChars. */
  result?: string;
  resultTruncated?: boolean;
  logs: string[];
  logTruncated: boolean;
  calls: number;
  durationMs: number;
  error?: ScriptError;
  /** Why the host stopped the run, if it did. */
  stopped?: "timeout" | "cancelled" | "call_limit" | "cpu" | "memory";
}

/** The guest side of the API, built inside the VM from three host functions. */
const PRELUDE = `(function (rawCall, rawLog, rawSleep, argsJson, helpersJson) {
  "use strict";
  const show = (v) => {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.name + ": " + v.message;
    try {
      const s = JSON.stringify(v);
      return s === undefined ? String(v) : s;
    } catch (e) {
      return String(v);
    }
  };
  const call = (name, params) => {
    let text;
    try {
      text = JSON.stringify(params === undefined ? {} : params);
    } catch (e) {
      return Promise.reject(new TypeError("mc.call params must be JSON: " + e.message));
    }
    return rawCall(String(name), text === undefined ? "{}" : text).then((r) => {
      const o = JSON.parse(r);
      if (o.ok) return o.result;
      const e = new Error(o.error.message);
      e.name = o.error.name;
      if (o.error.code !== undefined) e.code = o.error.code;
      if (o.error.data !== undefined) e.data = o.error.data;
      throw e;
    });
  };
  const log = (...a) => rawLog(a.map(show).join(" "));
  const mc = { args: JSON.parse(argsJson), call, log, sleep: (ms) => rawSleep(Number(ms)).then(() => undefined) };
  for (const name of JSON.parse(helpersJson)) mc[name] = (params) => call(name, params);
  Object.freeze(mc);
  Object.defineProperty(globalThis, "mc", { value: mc });
  Object.defineProperty(globalThis, "console", { value: Object.freeze({ log, info: log, warn: log, error: log }) });
})`;

/** The program as the body of an async function; the first line stays line 1 in stack traces. */
function wrap(code: string): string {
  return `(async () => {${code}\n})().then((v) => JSON.stringify(v === undefined ? null : v) ?? "null")`;
}

/** Compiles a program without running it; returns the syntax error, if any. */
export async function compileScript(code: string): Promise<ScriptError | undefined> {
  const mod = await newQuickJSWASMModule();
  const runtime = mod.newRuntime();
  runtime.setMemoryLimit(DEFAULT_LIMITS.memoryBytes);
  const deadline = Date.now() + DEFAULT_LIMITS.maxSliceMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const ctx = runtime.newContext();
  try {
    const r = ctx.evalCode(wrap(code), "script.js", { compileOnly: true });
    if (r.error) {
      const err = toScriptError(ctx.dump(r.error));
      r.error.dispose();
      return err;
    }
    r.value.dispose();
    return undefined;
  } finally {
    ctx.dispose();
    runtime.dispose();
  }
}

function toScriptError(dumped: unknown): ScriptError {
  if (dumped && typeof dumped === "object") {
    const d = dumped as Record<string, unknown>;
    const err: ScriptError = {
      name: typeof d.name === "string" ? d.name : "Error",
      message: typeof d.message === "string" ? d.message : JSON.stringify(dumped),
    };
    if (typeof d.stack === "string" && d.stack.trim()) err.stack = d.stack.trimEnd();
    if (typeof d.code === "string") err.code = d.code;
    return err;
  }
  return { name: "Error", message: `uncaught ${typeof dumped === "string" ? dumped : JSON.stringify(dumped)}` };
}

/**
 * Runs `code` with `args` as `mc.args`. Never throws for anything the program does: the outcome,
 * including errors and limits hit, is in the returned {@link ScriptRun}. Aborting `signal` stops it.
 */
export async function runScript(
  code: string,
  api: ScriptHostApi,
  opts: { args?: unknown; limits?: Partial<ScriptLimits>; signal?: AbortSignal } = {},
): Promise<ScriptRun> {
  const limits: ScriptLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const started = Date.now();
  const deadline = started + limits.timeoutMs;
  const logs: string[] = [];
  let logChars = 0;
  let logTruncated = false;
  let calls = 0;

  const mod = await newQuickJSWASMModule();
  const runtime = mod.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);

  /** Set once the host stops the run; the VM is interrupted and no more host calls start. */
  let stopped: ScriptRun["stopped"];
  /** Start of the current stretch of VM execution. */
  let sliceStart = Date.now();
  runtime.setInterruptHandler(() => {
    const now = Date.now();
    if (!stopped && now > deadline) stopped = "timeout";
    if (!stopped && now - sliceStart > limits.maxSliceMs) stopped = "cpu";
    return stopped !== undefined;
  });
  const ctx = runtime.newContext();

  let finished = false;
  let inFlight = 0;
  const open = new Set<QuickJSDeferredPromise>();
  const sleeps = new Set<NodeJS.Timeout>();
  let finish!: (run: ScriptRun) => void;
  const done = new Promise<ScriptRun>((resolve) => (finish = resolve));

  const outcome = (fields: Pick<ScriptRun, "ok" | "result" | "resultTruncated" | "error">): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    for (const t of sleeps) clearTimeout(t);
    opts.signal?.removeEventListener("abort", onAbort);
    const run: ScriptRun = { ...fields, logs, logTruncated, calls, durationMs: Date.now() - started };
    if (stopped) run.stopped = stopped;
    finish(run);
  };

  /** Ends the run with a host-side reason; the VM is not touched again. */
  const stop = (reason: NonNullable<ScriptRun["stopped"]>): void => {
    if (finished) return;
    stopped ??= reason;
    outcome({ ok: false, error: stopError(stopped, limits) });
  };
  const onAbort = () => stop("cancelled");
  const timer = setTimeout(() => stop("timeout"), Math.max(0, deadline - Date.now()));
  timer.unref?.();
  if (opts.signal?.aborted) stop("cancelled");
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  /** Maps an error thrown inside the VM to the outcome, preferring the host's reason. */
  const vmError = (handle: QuickJSHandle): ScriptError => {
    let dumped: unknown;
    try {
      dumped = ctx.dump(handle);
    } catch {
      dumped = { name: "InternalError", message: "the VM failed" };
    }
    const err = toScriptError(dumped);
    if (stopped) return stopError(stopped, limits);
    if (/out of memory/i.test(err.message) || dumped === null) {
      stopped = "memory";
      return stopError(stopped, limits);
    }
    return err;
  };

  let main: QuickJSHandle | undefined;

  /** Runs the VM's queued jobs, then checks whether the program has ended. */
  const pump = (): void => {
    if (finished) return;
    sliceStart = Date.now();
    try {
      const r = runtime.executePendingJobs();
      if (r.error) {
        const err = vmError(r.error);
        r.error.dispose();
        outcome({ ok: false, error: err });
        return;
      }
    } catch (err) {
      outcome({ ok: false, error: hostFailure(err, stopped, limits) });
      return;
    }
    if (!main) return;
    const state = ctx.getPromiseState(main);
    if (state.type === "fulfilled") {
      const text = ctx.typeof(state.value) === "string" ? ctx.getString(state.value) : "null";
      state.value.dispose();
      const cut = text.length > limits.maxResultChars;
      outcome({ ok: true, result: cut ? text.slice(0, limits.maxResultChars) : text, ...(cut ? { resultTruncated: true } : {}) });
    } else if (state.type === "rejected") {
      const err = vmError(state.error);
      state.error.dispose();
      outcome({ ok: false, error: err });
    } else if (inFlight === 0) {
      outcome({
        ok: false,
        error: { name: "Error", message: "the script is waiting on a promise that nothing will settle (only mc.call and mc.sleep run in the background)" },
      });
    }
  };

  /** A VM promise resolved with the text `work` produces on the host. */
  const hostPromise = (work: () => Promise<string>): QuickJSHandle => {
    const deferred = ctx.newPromise();
    open.add(deferred);
    inFlight++;
    work()
      .then((text) => {
        if (finished) return;
        const h = ctx.newString(text);
        deferred.resolve(h);
        h.dispose();
      })
      .catch((err: unknown) => outcome({ ok: false, error: hostFailure(err, stopped, limits) }))
      .finally(() => {
        inFlight--;
        open.delete(deferred);
        if (!finished) pump();
      });
    return deferred.handle;
  };

  /** `mc.call`: answers `{ ok, result }` or `{ ok: false, error }` as JSON; the prelude throws the error. */
  const rawCall = ctx.newFunction("call", (nameH, paramsH) => {
    const name = ctx.getString(nameH);
    const paramsText = ctx.getString(paramsH);
    return hostPromise(async () => {
      try {
        if (stopped || finished) throw new HostError("stopped", "the script was stopped");
        if (calls >= limits.maxCalls) {
          stop("call_limit");
          throw new HostError("call_limit", `call limit of ${limits.maxCalls} reached`);
        }
        calls++;
        const result = await api.call(name, JSON.parse(paramsText));
        const text = JSON.stringify({ ok: true, result: result === undefined ? null : result });
        if (text.length > MAX_HOST_RESULT_CHARS) {
          throw new HostError("too_large", `the result of ${name} is ${Math.round(text.length / 1e6)} MB of JSON; ask for less (a smaller area, a limit)`);
        }
        return text;
      } catch (err) {
        const error: Record<string, unknown> = {
          name: err instanceof HostError ? "BridgeError" : "Error",
          message: err instanceof Error ? err.message : String(err),
        };
        if (err instanceof HostError) {
          error.code = err.code;
          if (err.data !== undefined) error.data = err.data;
        }
        return JSON.stringify({ ok: false, error });
      }
    });
  });
  const rawLog = ctx.newFunction("log", (lineH) => {
    if (logTruncated) return;
    const line = ctx.getString(lineH);
    if (logChars + line.length > limits.maxLogChars) {
      logs.push(line.slice(0, Math.max(0, limits.maxLogChars - logChars)));
      logTruncated = true;
      logChars = limits.maxLogChars;
      return;
    }
    logs.push(line);
    logChars += line.length + 1;
  });
  const rawSleep = ctx.newFunction("sleep", (msH) => {
    const n = ctx.getNumber(msH);
    // Never past the deadline: the timeout ends the run then anyway.
    const ms = Math.min(Number.isFinite(n) ? Math.max(0, n) : 0, Math.max(0, deadline - Date.now()) + 1);
    return hostPromise(
      () =>
        new Promise<string>((resolve) => {
          const t = setTimeout(() => {
            sleeps.delete(t);
            resolve("null");
          }, ms);
          sleeps.add(t);
        }),
    );
  });

  try {
    const prelude = ctx.evalCode(PRELUDE, "prelude.js");
    const fn = ctx.unwrapResult(prelude);
    const argsH = ctx.newString(JSON.stringify(opts.args === undefined ? null : opts.args) ?? "null");
    const helpersH = ctx.newString(JSON.stringify(api.helpers));
    const setup = ctx.callFunction(fn, ctx.undefined, rawCall, rawLog, rawSleep, argsH, helpersH);
    for (const h of [fn, argsH, helpersH, rawCall, rawLog, rawSleep]) h.dispose();
    ctx.unwrapResult(setup).dispose();

    if (!finished) {
      sliceStart = Date.now();
      const r = ctx.evalCode(wrap(code), "script.js");
      if (r.error) {
        const err = vmError(r.error);
        r.error.dispose();
        outcome({ ok: false, error: err });
      } else {
        main = r.value;
        pump();
      }
    }
  } catch (err) {
    outcome({ ok: false, error: hostFailure(err, stopped, limits) });
  }

  const run = await done;
  // A run that ended cleanly frees its VM; any other is dropped with its WebAssembly module.
  if (run.ok && inFlight === 0) {
    try {
      main?.dispose();
      ctx.dispose();
      runtime.dispose();
    } catch {
      // leaked handles only matter to this module, which is discarded now
    }
  } else {
    for (const d of open) d.dispose();
  }
  return run;
}

const seconds = (ms: number) => Math.round(ms / 100) / 10;

function stopError(reason: NonNullable<ScriptRun["stopped"]>, limits: ScriptLimits): ScriptError {
  switch (reason) {
    case "timeout":
      return { name: "Timeout", message: `stopped at the time limit (${seconds(limits.timeoutMs)} s)` };
    case "cpu":
      return { name: "Timeout", message: `stopped after ${seconds(limits.maxSliceMs)} s of computation without awaiting mc.call or mc.sleep` };
    case "call_limit":
      return { name: "CallLimit", message: `stopped at the call limit (${limits.maxCalls} calls)` };
    case "memory":
      return { name: "OutOfMemory", message: `stopped at the memory limit (${Math.round(limits.memoryBytes / 1048576)} MiB)` };
    case "cancelled":
      return { name: "Cancelled", message: "the run was cancelled" };
  }
}

function hostFailure(err: unknown, stopped: ScriptRun["stopped"], limits: ScriptLimits): ScriptError {
  if (stopped) return stopError(stopped, limits);
  const message = err instanceof Error ? err.message : String(err);
  // A WebAssembly trap or an allocation failure inside the VM.
  if (/memory|out of bounds|unreachable/i.test(message)) return stopError("memory", limits);
  return { name: "InternalError", message };
}
