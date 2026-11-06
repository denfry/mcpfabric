/**
 * Finds the running game without MCPFABRIC_TOKEN: the mod writes `~/.mcpfabric/bridge.json`
 * (address and token, readable only by the user) while the bridge runs, and removes it when the
 * game stops. The file is read again on every call, so the MCP server can start before the game
 * and follows a restart. An explicit MCPFABRIC_TOKEN always wins.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BridgeTarget {
  url: string;
  token: string | undefined;
}

export function defaultDiscoveryPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MCPFABRIC_DISCOVERY || join(homedir(), ".mcpfabric", "bridge.json");
}

function alive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return true; // unknown: trust the file
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Reads the discovery file; caches it by modification time. */
export class Discovery {
  private cached: { mtimeMs: number; target: BridgeTarget | undefined } | undefined;

  constructor(readonly path: string) {}

  read(): BridgeTarget | undefined {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      this.cached = undefined;
      return undefined;
    }
    if (!this.cached || this.cached.mtimeMs !== mtimeMs) {
      this.cached = { mtimeMs, target: parse(readSafe(this.path)) };
    }
    const target = this.cached.target;
    return target && alive((target as BridgeTarget & { pid?: number }).pid) ? target : undefined;
  }
}

function readSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function parse(text: string | undefined): (BridgeTarget & { pid?: number }) | undefined {
  if (!text) return undefined;
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!o || typeof o !== "object") return undefined;
  const { url, token, pid } = o as Record<string, unknown>;
  if (typeof url !== "string" || !/^http:\/\/[^/]+$/.test(url)) return undefined;
  return {
    url,
    token: typeof token === "string" && token.length > 0 ? token : undefined,
    ...(typeof pid === "number" ? { pid } : {}),
  };
}
