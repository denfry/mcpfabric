/**
 * The guest side of `mcpfabric-test`: the test API a `.mctest.js` file sees inside the script
 * sandbox. It runs as the sandbox's `library` (after the `mc` prelude, before the test file) and
 * defines globals: test, beforeAll, afterAll, beforeEach, afterEach, step, expect, assert,
 * waitFor, waitForEvent, waitForChat, waitForScreen, mark, command, inventoryCount, sleep, params.
 *
 * The runner evaluates the file once per test, each time in a fresh VM, and appends a call to
 * `__mctest_main()`; `mc.args.__mctest` says what to do: list the tests, run the file's
 * beforeAll/afterAll hooks, or run one test with its beforeEach/afterEach hooks. The answer is the
 * script's return value, checked by the runner (runner.ts).
 *
 * Written as plain JavaScript for QuickJS inside a raw template literal: no backquotes in it, and
 * the protocol version is the only substitution.
 */
export const TEST_PROTOCOL = 1;

export const TEST_LIBRARY = String.raw`(function () {
  "use strict";
  const PROTOCOL = ${TEST_PROTOCOL};
  const g = globalThis;
  const ctl = (mc.args && mc.args.__mctest) || { mode: "list" };
  const DEFAULT_TIMEOUT = typeof ctl.timeoutMs === "number" ? ctl.timeoutMs : 30000;
  const HOOK_TIMEOUT = typeof ctl.hookTimeoutMs === "number" ? ctl.hookTimeoutMs : 30000;

  class AssertionError extends Error {
    constructor(message) { super(message); this.name = "AssertionError"; }
  }
  class TimeoutError extends Error {
    constructor(message) { super(message); this.name = "TimeoutError"; }
  }

  const show = (v) => {
    let s;
    if (typeof v === "string") s = JSON.stringify(v);
    else if (typeof v === "function") s = "[function]";
    else if (v instanceof RegExp) s = String(v);
    else if (v instanceof Error) s = v.name + ": " + v.message;
    else {
      try { s = JSON.stringify(v); } catch (e) { s = String(v); }
      if (s === undefined) s = String(v);
    }
    return s.length > 300 ? s.slice(0, 300) + "..." : s;
  };

  const deepEqual = (a, b) => {
    if (Object.is(a, b)) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
      return true;
    }
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
    return true;
  };

  const now = () => Date.now();
  /** A copy without the g and y flags, whose test() does not depend on the previous call. */
  const stateless = (re) => new RegExp(re.source, re.flags.replace(/[gy]/g, ""));
  const sleep = (ms) => mc.sleep(ms);

  /** Rejects with a TimeoutError after ms unless fn settles first. */
  const withTimeout = (fn, ms, what) =>
    Promise.race([
      Promise.resolve().then(fn),
      mc.sleep(ms).then(() => { throw new TimeoutError(what + " timed out after " + ms + " ms"); }),
    ]);

  // ---- registration -------------------------------------------------------------------------

  const tests = [];
  const hooks = { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] };

  const register = (name, fn, opts, mark) => {
    if (typeof name !== "string" || name.trim() === "") throw new TypeError("test(name, fn): name must be a non-empty string");
    if (typeof fn !== "function") throw new TypeError("test(" + JSON.stringify(name) + ", fn): fn must be a function");
    if (tests.some((t) => t.name === name)) throw new Error("two tests are named " + JSON.stringify(name) + "; names must be unique in a file");
    const o = opts || {};
    if (o.timeout !== undefined && !(typeof o.timeout === "number" && o.timeout > 0)) throw new TypeError("test option timeout must be a positive number of ms");
    tests.push({ name, fn, timeout: o.timeout || DEFAULT_TIMEOUT, skip: mark === "skip", only: mark === "only" });
  };
  const test = (name, fn, opts) => register(name, fn, opts, null);
  test.skip = (name, fn, opts) => register(name, fn || (() => {}), opts, "skip");
  test.only = (name, fn, opts) => register(name, fn, opts, "only");
  Object.freeze(test);

  const hook = (kind) => (fn, opts) => {
    if (typeof fn !== "function") throw new TypeError(kind + "(fn): fn must be a function");
    const o = opts || {};
    hooks[kind].push({ fn, timeout: o.timeout || HOOK_TIMEOUT });
  };

  // ---- steps --------------------------------------------------------------------------------

  let steps = [];
  const stack = [];
  const step = async (name, fn) => {
    if (typeof fn !== "function") throw new TypeError("step(name, fn): fn must be a function");
    const rec = { name: String(name), depth: stack.length, status: "running", durationMs: 0 };
    steps.push(rec);
    stack.push(rec.name);
    const t0 = now();
    try {
      const v = await fn();
      rec.status = "passed";
      return v;
    } catch (e) {
      rec.status = "failed";
      if (e && typeof e === "object" && e.mctestStep === undefined) {
        try { e.mctestStep = stack.join(" > "); } catch (ignored) { /* frozen error */ }
      }
      throw e;
    } finally {
      rec.durationMs = now() - t0;
      stack.pop();
    }
  };

  // ---- assertions ---------------------------------------------------------------------------

  const MATCHERS = {
    toBe: (a, e) => [Object.is(a, e), "to be " + show(e)],
    toEqual: (a, e) => [deepEqual(a, e), "to equal " + show(e)],
    toBeTruthy: (a) => [!!a, "to be truthy"],
    toBeFalsy: (a) => [!a, "to be falsy"],
    toBeDefined: (a) => [a !== undefined, "to be defined"],
    toBeUndefined: (a) => [a === undefined, "to be undefined"],
    toBeNull: (a) => [a === null, "to be null"],
    toContain: (a, item) => {
      if (typeof a === "string") return [a.includes(String(item)), "to contain " + show(item)];
      if (Array.isArray(a)) return [a.some((x) => deepEqual(x, item)), "to contain " + show(item)];
      return [false, "to contain " + show(item) + " (it is neither a string nor an array)"];
    },
    toMatch: (a, re) => {
      if (typeof a !== "string") return [false, "to match " + show(re) + " (it is not a string)"];
      return [re instanceof RegExp ? stateless(re).test(a) : a.includes(String(re)), "to match " + show(re)];
    },
    toBeGreaterThan: (a, n) => [a > n, "to be greater than " + show(n)],
    toBeGreaterThanOrEqual: (a, n) => [a >= n, "to be greater than or equal to " + show(n)],
    toBeLessThan: (a, n) => [a < n, "to be less than " + show(n)],
    toBeLessThanOrEqual: (a, n) => [a <= n, "to be less than or equal to " + show(n)],
    toBeCloseTo: (a, n, digits) => {
      const d = digits === undefined ? 2 : digits;
      return [typeof a === "number" && Math.abs(a - n) < Math.pow(10, -d) / 2, "to be close to " + show(n) + " (" + d + " digits)"];
    },
    toHaveLength: (a, n) => [a !== null && a !== undefined && a.length === n, "to have length " + n],
    toHaveProperty: (a, path, ...rest) => {
      let cur = a;
      for (const k of String(path).split(".")) {
        if (cur === null || cur === undefined || !Object.prototype.hasOwnProperty.call(Object(cur), k)) return [false, "to have property " + path];
        cur = cur[k];
      }
      if (rest.length === 0) return [true, "to have property " + path];
      return [deepEqual(cur, rest[0]), "to have property " + path + " equal to " + show(rest[0]) + " (it is " + show(cur) + ")"];
    },
  };

  const failure = (actual, negate, what, message) =>
    new AssertionError((message ? message + ": " : "") + "expected " + show(actual) + (negate ? " not " : " ") + what);

  const matchers = (actual, negate, message) => {
    const out = {};
    for (const name of Object.keys(MATCHERS)) {
      out[name] = (...args) => {
        const r = MATCHERS[name](actual, ...args);
        if (r[0] === negate) throw failure(actual, negate, r[1], message);
      };
    }
    return out;
  };

  const expect = (actual, message) => {
    const m = matchers(actual, false, message);
    m.not = matchers(actual, true, message);
    return m;
  };

  /** Matchers that call fn until the expectation holds or the timeout passes. */
  const pollMatchers = (fn, opts, negate) => {
    const o = typeof opts === "number" ? { timeout: opts } : opts || {};
    const timeout = o.timeout === undefined ? 10000 : o.timeout;
    const interval = Math.max(50, o.interval === undefined ? 250 : o.interval);
    const out = {};
    for (const name of Object.keys(MATCHERS)) {
      out[name] = async (...args) => {
        const t0 = now();
        let tries = 0;
        let last;
        let lastError;
        for (;;) {
          tries++;
          try {
            last = await fn();
            lastError = undefined;
            const r = MATCHERS[name](last, ...args);
            if (r[0] !== negate) return last;
            if (now() - t0 >= timeout) {
              const e = failure(last, negate, r[1], o.message);
              e.message += " (polled " + tries + " times for " + timeout + " ms)";
              throw e;
            }
          } catch (e) {
            if (e instanceof AssertionError) throw e;
            lastError = e;
            if (now() - t0 >= timeout) {
              throw new AssertionError((o.message ? o.message + ": " : "") + "the polled function kept failing for " + timeout + " ms: " + show(lastError));
            }
          }
          await mc.sleep(Math.min(interval, Math.max(0, timeout - (now() - t0))));
        }
      };
    }
    return out;
  };
  expect.poll = (fn, opts) => {
    if (typeof fn !== "function") throw new TypeError("expect.poll(fn): fn must be a function");
    const m = pollMatchers(fn, opts, false);
    m.not = pollMatchers(fn, opts, true);
    return m;
  };
  Object.freeze(expect);

  const assert = (cond, message) => {
    if (!cond) throw new AssertionError(message || "assertion failed");
  };
  assert.equal = (a, b, message) => { if (!deepEqual(a, b)) throw new AssertionError((message ? message + ": " : "") + "expected " + show(a) + " to equal " + show(b)); };
  assert.fail = (message) => { throw new AssertionError(message || "failed"); };
  Object.freeze(assert);

  // ---- waiting ------------------------------------------------------------------------------

  const waitOpts = (opts, what) => {
    const o = typeof opts === "number" ? { timeout: opts } : opts || {};
    return {
      timeout: o.timeout === undefined ? 10000 : o.timeout,
      interval: Math.max(50, o.interval === undefined ? 250 : o.interval),
      message: o.message || what,
      raw: o,
    };
  };

  /** Calls fn until it returns something truthy (and returns that); a throw counts as "not yet". */
  const waitFor = async (fn, opts) => {
    if (typeof fn !== "function") throw new TypeError("waitFor(fn): fn must be a function");
    const o = waitOpts(opts, "waitFor");
    const t0 = now();
    let tries = 0;
    let last;
    let lastError;
    for (;;) {
      tries++;
      try {
        last = await fn();
        lastError = undefined;
        if (last) return last;
      } catch (e) {
        lastError = e;
      }
      if (now() - t0 >= o.timeout) {
        throw new TimeoutError(
          o.message + " timed out after " + o.timeout + " ms (" + tries + " tries)" +
            (lastError ? ", last error: " + show(lastError) : ", last value: " + show(last)),
        );
      }
      await mc.sleep(Math.min(o.interval, Math.max(0, o.timeout - (now() - t0))));
    }
  };

  /** Events are matched after this id; each match moves it forward, so waits match in order. */
  let cursor = 0;
  /**
   * Chat lines already matched. The integrated server and the client both report one message
   * (with different decoration and event types), so a line next to a matched one that the same
   * pattern accepts counts as that line again.
   */
  const consumed = [];

  const mark = async () => (await mc.call("events.getRecent", { limit: 1, types: ["mctest:none"] })).lastId;

  const eventText = (e) => (e && e.data && typeof e.data.text === "string" ? e.data.text : "");
  const isDuplicate = (e, accepts) => consumed.some((c) => c.id !== e.id && Math.abs(c.id - e.id) <= 8 && accepts(c));

  const waitForEventsMatching = async (types, where, opts, what, dedupe) => {
    const o = waitOpts(opts, what);
    let since = typeof o.raw.since === "number" ? o.raw.since : cursor;
    let seen = 0;
    let found;
    try {
      found = await waitFor(async () => {
        const r = await mc.call("events.getRecent", { limit: 500, sinceId: since, ...(types ? { types } : {}) });
        for (const e of r.events) {
          since = Math.max(since, e.id);
          if (dedupe && isDuplicate(e, dedupe)) continue;
          if (!where || where(e)) return e;
          seen++;
        }
        return undefined;
      }, { timeout: o.timeout, interval: o.interval, message: o.message });
    } catch (e) {
      if (e instanceof TimeoutError) e.message = o.message + " timed out after " + o.timeout + " ms (" + seen + " other matching-type events seen)";
      throw e;
    }
    cursor = Math.max(cursor, found.id);
    return found;
  };

  const waitForEvent = (types, opts) => {
    const list = Array.isArray(types) ? types : [types];
    if (list.length === 0 || list.some((t) => typeof t !== "string")) throw new TypeError("waitForEvent(types): give an event type or a list of them");
    const o = typeof opts === "function" ? { where: opts } : opts || {};
    return waitForEventsMatching(list, o.where, o, "waitForEvent(" + list.join(", ") + ")");
  };

  const waitForChat = async (pattern, opts) => {
    if (typeof pattern !== "string" && !(pattern instanceof RegExp)) throw new TypeError("waitForChat(pattern): give a string or a RegExp");
    const o = opts || {};
    const re = typeof pattern === "string" ? null : stateless(pattern);
    const textMatches = (text) => (re ? re.test(text) : text.includes(pattern));
    const matches = (e) => {
      if (!textMatches(eventText(e))) return false;
      if (o.from !== undefined && e.data.sender !== o.from && e.data.player !== o.from) return false;
      return true;
    };
    const e = await waitForEventsMatching(["chat", "system_message"], matches, o, "waitForChat(" + show(pattern) + ")", (c) => textMatches(c.text));
    consumed.push({ id: e.id, text: eventText(e) });
    if (consumed.length > 64) consumed.shift();
    return { text: eventText(e), type: e.type, sender: e.data.sender || e.data.player, id: e.id };
  };

  const waitForScreen = (match, opts) => {
    const ok =
      typeof match === "function" ? match
      : typeof match === "string" ? (s) => s.screen === match || (typeof s.title === "string" && s.title.includes(match))
      : null;
    if (!ok) throw new TypeError("waitForScreen(match): give a screen kind (\"none\", \"container\", ...), part of a title, or a function");
    return waitFor(async () => {
      const s = await mc.call("screen.get", {});
      return ok(s) ? s : undefined;
    }, waitOpts(opts, "waitForScreen(" + show(typeof match === "function" ? "[function]" : match) + ")"));
  };

  /** Runs a server command; throws when the game reports that it failed. */
  const command = async (text) => {
    const r = await mc.call("command.run", { command: String(text) });
    if (r && r.success === false) {
      const out = Array.isArray(r.output) && r.output.length > 0 ? ": " + r.output.join(" | ") : "";
      throw new Error("command failed: /" + String(text).replace(/^\//, "") + out);
    }
    return r;
  };

  const inventoryCount = async (item) => {
    const id = String(item).includes(":") ? String(item) : "minecraft:" + String(item);
    const inv = await mc.call("player.getInventory", {});
    let n = 0;
    for (const s of [].concat(inv.hotbar || [], inv.main || [], inv.offhand ? [inv.offhand] : [])) {
      if (s && s.id === id) n += s.count || 0;
    }
    return n;
  };

  // ---- running ------------------------------------------------------------------------------

  const errorJson = (e, phase) => {
    if (e && typeof e === "object") {
      const out = { name: String(e.name || "Error"), message: String(e.message === undefined ? show(e) : e.message), phase };
      if (typeof e.stack === "string" && e.stack.trim()) out.stack = e.stack.trimEnd();
      if (typeof e.mctestStep === "string") out.step = e.mctestStep;
      if (typeof e.code === "string") out.code = e.code;
      return out;
    }
    return { name: "Error", message: "thrown: " + show(e), phase };
  };

  const runHooks = async (list, phase) => {
    for (const h of list) {
      try {
        await withTimeout(h.fn, h.timeout, phase);
      } catch (e) {
        return errorJson(e, phase);
      }
    }
    return undefined;
  };

  g.__mctest_main = async () => {
    if (ctl.mode === "list") {
      return {
        protocol: PROTOCOL,
        tests: tests.map((t) => ({ name: t.name, skip: t.skip, only: t.only, timeoutMs: t.timeout })),
        hooks: { beforeAll: hooks.beforeAll.length, afterAll: hooks.afterAll.length, beforeEach: hooks.beforeEach.length, afterEach: hooks.afterEach.length },
      };
    }
    if (ctl.mode === "hook") {
      const error = await runHooks(hooks[ctl.hook] || [], ctl.hook);
      return { protocol: PROTOCOL, ok: !error, error };
    }
    if (ctl.mode !== "run") throw new Error("unknown runner mode " + show(ctl.mode));
    const t = tests[ctl.index];
    if (!t || t.name !== ctl.name) throw new Error("the file changed while it ran: test " + show(ctl.name) + " is not where it was");
    const baseline = await mark();
    cursor = baseline;
    steps = [];
    const t0 = now();
    let error = await runHooks(hooks.beforeEach, "beforeEach");
    if (!error) {
      try {
        await withTimeout(() => t.fn({ name: t.name, attempt: ctl.attempt || 1, step, log: mc.log }), t.timeout, "test");
      } catch (e) {
        error = errorJson(e, "test");
      }
    }
    const after = await runHooks(hooks.afterEach, "afterEach");
    if (!error && after) error = after;
    for (const s of steps) if (s.status === "running") s.status = "interrupted";
    return { protocol: PROTOCOL, name: t.name, ok: !error, durationMs: now() - t0, steps, error, afterEachError: error === after ? undefined : after, baseline };
  };

  const define = (name, value) => Object.defineProperty(g, name, { value, configurable: false, writable: false });
  define("test", test);
  define("beforeAll", hook("beforeAll"));
  define("afterAll", hook("afterAll"));
  define("beforeEach", hook("beforeEach"));
  define("afterEach", hook("afterEach"));
  define("step", step);
  define("expect", expect);
  define("assert", assert);
  define("waitFor", waitFor);
  define("waitForEvent", waitForEvent);
  define("waitForChat", waitForChat);
  define("waitForScreen", waitForScreen);
  define("mark", mark);
  define("command", command);
  define("inventoryCount", inventoryCount);
  define("sleep", sleep);
  define("params", Object.freeze(Object.assign({}, ctl.params || {})));
  define("AssertionError", AssertionError);
  define("TimeoutError", TimeoutError);
})();`;

/** Appended to a test file: hands the runner the answer for the requested mode. */
export const TEST_EPILOGUE = "\n;return await __mctest_main();";
