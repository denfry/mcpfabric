/**
 * Thin HTTP client for the in-game bridge exposed by the mcpfabric Fabric mod.
 *
 * The mod exposes a single JSON-RPC-style endpoint `POST /rpc` taking `{ method, params }` and
 * returning either `{ ok: true, result }` or `{ ok: false, error: { code, message, data? } }`.
 * It also exposes `GET /health`, `GET /info`, and `GET /events` (SSE).
 */

import type { BridgeTarget } from "./discovery.js";

export interface BridgeErrorBody {
  code: string;
  message: string;
  data?: unknown;
}

/** Error thrown when the bridge is reachable but the call itself failed. */
export class BridgeError extends Error {
  readonly code: string;
  readonly data?: unknown;
  constructor(body: BridgeErrorBody) {
    super(body.message);
    this.name = "BridgeError";
    this.code = body.code;
    this.data = body.data;
  }
}

/** Error thrown when the bridge could not be reached at all (mod not running, wrong port, etc.). */
export class BridgeUnreachableError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "BridgeUnreachableError";
    this.cause = cause;
  }
}

/** One event from the bridge's ring buffer, as `GET /events` and `events.getRecent` send it. */
export interface BridgeEvent {
  id: number;
  type: string;
  gameTime: number;
  data: Record<string, unknown>;
}

interface RpcEnvelope<T> {
  ok: boolean;
  result?: T;
  error?: BridgeErrorBody;
}

/**
 * What the MCP server needs from the game: the mod's HTTP bridge (BridgeClient) or another backend
 * that answers the same RPC methods (horizon/bridge.ts).
 */
export interface GameBridge {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  streamEvents(types: string[], signal: AbortSignal, onEvent: (event: BridgeEvent) => void, idleMs?: number): Promise<void>;
  info<T = unknown>(): Promise<T>;
  target(): BridgeTarget;
  /** Whether the backend serves this RPC method at all; its tool is not registered otherwise. */
  supports(method: string): boolean;
}

export class BridgeClient implements GameBridge {
  /** The mod's router is the authority: every catalogued method is offered, and gated in the game. */
  supports(_method: string): boolean {
    return true;
  }

  /**
   * @param discover where to look for the running game when no token is configured
   *   (`~/.mcpfabric/bridge.json`, see discovery.ts); its address and token are used instead.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly timeoutMs: number,
    private readonly discover?: () => BridgeTarget | undefined,
  ) {}

  /** Address and token for the next request. */
  target(): BridgeTarget {
    if (this.token || !this.discover) return { url: this.baseUrl, token: this.token };
    return this.discover() ?? { url: this.baseUrl, token: undefined };
  }

  private headers(token: string | undefined): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (token) h.authorization = `Bearer ${token}`;
    return h;
  }

  private async fetchWithTimeout(path: string, init: RequestInit): Promise<Response> {
    const { url, token } = this.target();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url + path, { ...init, headers: this.headers(token), signal: controller.signal });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === "AbortError"
          ? `timed out after ${this.timeoutMs}ms`
          : (err as Error)?.message ?? String(err);
      throw new BridgeUnreachableError(
        `Could not reach the mcpfabric bridge at ${url} (${reason}). ` +
          `Is Minecraft running with the mod loaded, and is MCPFABRIC_URL correct?`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Invoke a bridge RPC method. Throws BridgeError / BridgeUnreachableError on failure. */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchWithTimeout("/rpc", {
      method: "POST",
      body: JSON.stringify({ method, params }),
    });

    if (res.status === 401 || res.status === 403) {
      throw new BridgeError({
        code: "unauthorized",
        message:
          "Bridge rejected the auth token. Set MCPFABRIC_TOKEN to the token in config/mcpfabric.config.json " +
          "of the game, or unset it so the token is read from ~/.mcpfabric/bridge.json while the game runs.",
      });
    }

    let body: RpcEnvelope<T>;
    try {
      body = (await res.json()) as RpcEnvelope<T>;
    } catch {
      throw new BridgeError({
        code: "bad_response",
        message: `Bridge returned a non-JSON response (HTTP ${res.status}).`,
      });
    }

    if (!body.ok) {
      throw new BridgeError(body.error ?? { code: "unknown", message: "Unknown bridge error" });
    }
    return body.result as T;
  }

  /**
   * Opens one `GET /events` stream (only `types`, if given) and calls `onEvent` for each event
   * until the stream ends, `signal` aborts, or nothing (not even a keepalive) arrives for
   * `idleMs`. Resolves when the stream ends; throws when it cannot be opened. The bridge caps the
   * number of open streams, so callers keep at most one and reconnect with a backoff.
   */
  async streamEvents(
    types: string[],
    signal: AbortSignal,
    onEvent: (event: BridgeEvent) => void,
    idleMs = 45_000,
  ): Promise<void> {
    const query = types.length > 0 ? `?types=${types.map(encodeURIComponent).join(",")}` : "";
    const local = new AbortController();
    const abort = () => local.abort();
    signal.addEventListener("abort", abort, { once: true });
    let idle: NodeJS.Timeout | undefined;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(abort, idleMs);
      idle.unref?.();
    };
    try {
      touch();
      // Resolved per stream, so a reconnect follows a game that restarted (discovery file).
      const { url, token } = this.target();
      let res: Response;
      try {
        res = await fetch(url + "/events" + query, { method: "GET", headers: this.headers(token), signal: local.signal });
      } catch (err) {
        throw new BridgeUnreachableError(`Could not open the event stream at ${url} (${(err as Error)?.message ?? String(err)}).`, err);
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        throw new BridgeError({ code: res.status === 503 ? "too_many_streams" : "bad_response", message: `Event stream refused (HTTP ${res.status}).` });
      }
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          touch();
          buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, ""))
              .join("\n");
            if (!data) continue; // comment or keepalive
            let event: BridgeEvent;
            try {
              event = JSON.parse(data) as BridgeEvent;
            } catch {
              continue;
            }
            onEvent(event);
          }
        }
      } catch (err) {
        // An abort (ours, idle or the caller's) just ends the stream.
        if (!local.signal.aborted) throw err;
      }
    } finally {
      clearTimeout(idle);
      signal.removeEventListener("abort", abort);
    }
  }

  /** Lightweight liveness probe. Returns the parsed `/info` payload or throws if unreachable. */
  async info<T = unknown>(): Promise<T> {
    const res = await this.fetchWithTimeout("/info", { method: "GET" });
    return (await res.json()) as T;
  }
}
