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

interface RpcEnvelope<T> {
  ok: boolean;
  result?: T;
  error?: BridgeErrorBody;
}

export class BridgeClient {
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

  /** Lightweight liveness probe. Returns the parsed `/info` payload or throws if unreachable. */
  async info<T = unknown>(): Promise<T> {
    const res = await this.fetchWithTimeout("/info", { method: "GET" });
    return (await res.json()) as T;
  }
}
