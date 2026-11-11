/**
 * The bridge backend for Horizon (a Rust rewrite of Minecraft: Java Edition 26.3): answers the
 * mod's RPC methods (`tools.ts`, the agent runtime, scripts) by driving Horizon's own agent control
 * socket, so the MCP tools, memory, goals, jobs and skills work there unchanged.
 *
 * The mapping is per method (`methods.ts`). Methods Horizon cannot answer are not served at all:
 * `supports()` is false for them, so their tools are not registered, and a call answers
 * `unsupported_on_horizon`.
 */
import { BridgeError, BridgeUnreachableError, type BridgeEvent, type GameBridge } from "../bridge.js";
import type { BridgeTarget } from "../discovery.js";
import { ControlConnection, ControlError, ControlUnreachableError, defaultControlPath, readEndpoint, type ControlReply } from "./control.js";
import { mapEvent } from "./events.js";
import { HORIZON_METHODS, type HorizonContext } from "./methods.js";

export interface HorizonOptions {
  /** The control endpoint (`defaultControlPath()` when not given). */
  path?: string;
  /** Upper bound for one quick command (state, block, inventory...). */
  timeoutMs: number;
  /** Serve the ui.* methods (Horizon's widget clicks); off unless MCPFABRIC_HORIZON_UI is set, like enableUiControl. */
  uiControl: boolean;
  /** Key for opaque server ids (`mp:`), so a server's address never reaches the model. */
  worldKey: () => Buffer;
  /** How often streamEvents polls `events` (ms). */
  pollMs?: number;
}

/** One background action (goto, break, use-item --hold): Horizon runs one at a time. */
interface ActionState {
  name: string;
  startedAt: number;
  promise: Promise<ControlReply>;
  /** Set when it ended: the reply, or why it failed. */
  result?: { ok: true; reply: ControlReply } | { ok: false; error: string; kind: string };
  stopped?: boolean;
  /** Extra data the method that started it keeps (nav target...). */
  meta: Record<string, unknown>;
}

/** How long a new action waits for the running one to end before it is refused as busy. */
const BUSY_WAIT_MS = 3000;

const UI_METHODS = new Set(["ui.widgets", "ui.click"]);

export class HorizonBridge implements GameBridge, HorizonContext {
  readonly backend = "horizon";
  private readonly path: string;
  private query?: Promise<ControlConnection>;
  private actionConn?: Promise<ControlConnection>;
  private current?: ActionState;
  /** The last world or server joined through session.join, for a rejoin without an id. */
  lastWorld?: { kind: "sp"; folder: string } | { kind: "mp"; address: string };

  constructor(private readonly opts: HorizonOptions) {
    this.path = opts.path ?? defaultControlPath();
  }

  target(): BridgeTarget {
    return { url: `horizon:${this.path}`, token: undefined };
  }

  supports(method: string): boolean {
    if (UI_METHODS.has(method) && !this.opts.uiControl) return false;
    return Object.hasOwn(HORIZON_METHODS, method);
  }

  /** Every method this backend serves, for info.status. */
  methods(): string[] {
    return Object.keys(HORIZON_METHODS).filter((m) => this.supports(m)).sort();
  }

  worldKey(): Buffer {
    return this.opts.worldKey();
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.supports(method)) {
      throw new BridgeError({
        code: UI_METHODS.has(method) ? "capability_disabled" : "unsupported_on_horizon",
        message: UI_METHODS.has(method)
          ? `${method} is off: set MCPFABRIC_HORIZON_UI=1 to let the agent click Horizon's widgets.`
          : `${method} is not available on Horizon (the game has no equivalent control command yet).`,
      });
    }
    try {
      return (await HORIZON_METHODS[method]!(this, params)) as T;
    } catch (err) {
      throw toBridgeError(err);
    }
  }

  async info<T = unknown>(): Promise<T> {
    const hello = await this.cmd("hello");
    return { backend: "horizon", protocol: hello.protocol, release: hello.release, features: hello.features } as T;
  }

  /** Runs one quick command on the shared connection, reconnecting once if the game restarted. */
  async cmd(line: string, timeoutMs = this.opts.timeoutMs): Promise<ControlReply> {
    for (let attempt = 0; ; attempt++) {
      const conn = await this.connection("query");
      try {
        return await conn.send(line, timeoutMs);
      } catch (err) {
        if (err instanceof ControlUnreachableError && attempt === 0 && conn.closed) {
          this.query = undefined;
          continue;
        }
        if (err instanceof ControlUnreachableError) this.query = undefined;
        throw err;
      }
    }
  }

  /**
   * Starts a blocking Horizon action (goto, break...) on its own connection and returns at once,
   * or throws right away if the game refused it within `settleMs` (no path, busy, out of reach).
   */
  async startAction(name: string, line: string, timeoutMs: number, meta: Record<string, unknown> = {}, settleMs = 250): Promise<ActionState> {
    // A finishing action (break waits up to a second for its drops) gets a moment to end first.
    const running = this.current && !this.current.result ? this.current : undefined;
    if (running) await Promise.race([running.promise.catch(() => undefined), new Promise((r) => setTimeout(r, BUSY_WAIT_MS))]);
    if (this.current && !this.current.result) {
      throw new ControlError(`busy with ${this.current.name}; wait for it or stop it`, "busy");
    }
    const conn = await this.connection("action");
    const state: ActionState = { name, startedAt: Date.now(), meta, promise: conn.send(line, timeoutMs) };
    this.current = state;
    state.promise.then(
      (reply) => {
        state.result = { ok: true, reply };
      },
      (err: unknown) => {
        if (err instanceof ControlUnreachableError) this.actionConn = undefined;
        state.result = { ok: false, error: (err as Error).message, kind: err instanceof ControlError ? err.kind : "unreachable" };
      },
    );
    // An immediate refusal is the caller's error, not a background failure to discover later.
    await Promise.race([state.promise.catch(() => undefined), new Promise((r) => setTimeout(r, settleMs))]);
    if (state.result && !state.result.ok) throw new ControlError(state.result.error, state.result.kind);
    return state;
  }

  /** Runs a blocking action and waits for its reply. */
  async runAction(name: string, line: string, timeoutMs: number): Promise<ControlReply> {
    const state = await this.startAction(name, line, timeoutMs, {}, 0);
    return state.promise;
  }

  action(): ActionState | undefined {
    return this.current;
  }

  /** Cancels the running action (Horizon's `stop` also releases every key). */
  async stopAction(): Promise<boolean> {
    const running = this.current && !this.current.result ? this.current : undefined;
    if (running) running.stopped = true;
    await this.cmd("stop");
    return running !== undefined;
  }

  async streamEvents(types: string[], signal: AbortSignal, onEvent: (event: BridgeEvent) => void): Promise<void> {
    const pollMs = this.opts.pollMs ?? 500;
    const wanted = new Set(types);
    // Start from now: the channel reports what happens while it listens.
    let since = Number((await this.cmd("events")).last ?? 0);
    while (!signal.aborted) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pollMs);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
      if (signal.aborted) return;
      const reply = await this.cmd(`events --since ${since}`);
      since = Number(reply.last ?? since);
      for (const raw of (reply.events as Record<string, unknown>[] | undefined) ?? []) {
        for (const event of mapEvent(raw)) if (wanted.size === 0 || wanted.has(event.type)) onEvent(event);
      }
    }
  }

  private connection(kind: "query" | "action"): Promise<ControlConnection> {
    const existing = kind === "query" ? this.query : this.actionConn;
    if (existing) {
      return existing.then(
        (c) => (c.closed ? this.reopen(kind) : c),
        () => this.reopen(kind),
      );
    }
    return this.reopen(kind);
  }

  private reopen(kind: "query" | "action"): Promise<ControlConnection> {
    // The endpoint is read again each time: a restarted game writes a new port and token.
    const opened = (async () => ControlConnection.open(readEndpoint(this.path), this.opts.timeoutMs))();
    if (kind === "query") this.query = opened;
    else this.actionConn = opened;
    opened.catch(() => {
      if (kind === "query" && this.query === opened) this.query = undefined;
      if (kind === "action" && this.actionConn === opened) this.actionConn = undefined;
    });
    return opened;
  }
}

function toBridgeError(err: unknown): Error {
  if (err instanceof BridgeError || err instanceof BridgeUnreachableError) return err;
  if (err instanceof ControlUnreachableError) return new BridgeUnreachableError(err.message, err);
  if (err instanceof ControlError) {
    const code = err.kind === "denied" ? "ai_disabled" : err.kind === "horizon_error" ? "horizon_error" : err.kind;
    return new BridgeError({ code, message: err.message });
  }
  const code = (err as { code?: unknown })?.code;
  return new BridgeError({ code: typeof code === "string" ? code : "invalid_params", message: (err as Error)?.message ?? String(err) });
}
