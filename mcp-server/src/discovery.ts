/**
 * Finds the running game without MCPFABRIC_TOKEN: the mod writes `~/.mcpfabric/bridge.json`
 * (address and token, readable only by the user) while the bridge runs, and removes it when the
 * game stops. The file is read again on every call, so the MCP server can start before the game
 * and follows a restart. An explicit MCPFABRIC_TOKEN always wins.
 *
 * With several games running, each also writes `~/.mcpfabric/bridges/<pid>.json` with a name (the
 * mod's instanceName, the player's account name or the game folder's name). MCPFABRIC_INSTANCE picks
 * one of them by that name, the player, the folder or the pid; without it the newest game is used.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

/** A running game as its own discovery file describes it. */
export interface Instance {
  name: string;
  player?: string;
  gameDir?: string;
  pid?: number;
  url: string;
  mtimeMs: number;
}

/** How long a scan of the instance folder is reused: the folder is read at most once a second. */
const SCAN_MS = 1000;

/** Reads the discovery file; caches it by modification time. */
export class Discovery {
  private cached: { mtimeMs: number; target: BridgeTarget | undefined } | undefined;
  private scanned: { at: number; found: (Instance & { target: BridgeTarget })[] } | undefined;

  /** `instance`: MCPFABRIC_INSTANCE; then the game is looked up in the `bridges` folder next to `path`. */
  constructor(
    readonly path: string,
    readonly instance?: string,
  ) {}

  /** The running games that wrote an instance file, newest first. */
  instances(): Instance[] {
    return this.scan().map(({ target: _target, ...i }) => i);
  }

  private scan(): (Instance & { target: BridgeTarget })[] {
    const now = Date.now();
    if (this.scanned && now - this.scanned.at < SCAN_MS) return this.scanned.found;
    const dir = join(dirname(this.path), "bridges");
    const found: (Instance & { target: BridgeTarget })[] = [];
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
    } catch {
      // No folder: no game wrote one.
    }
    for (const f of files) {
      const path = join(dir, f);
      const text = readSafe(path);
      const target = parse(text);
      if (!target || !alive(target.pid)) continue;
      let extra: Record<string, unknown> = {};
      try {
        extra = JSON.parse(text!) as Record<string, unknown>;
      } catch {
        continue;
      }
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
      const player = str(extra.player);
      const gameDir = str(extra.gameDir);
      found.push({
        name: str(extra.name) ?? player ?? gameDir ?? String(target.pid ?? f),
        ...(player ? { player } : {}),
        ...(gameDir ? { gameDir } : {}),
        ...(target.pid !== undefined ? { pid: target.pid } : {}),
        url: target.url,
        mtimeMs,
        target: { url: target.url, token: target.token },
      });
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    this.scanned = { at: now, found };
    return found;
  }

  /** The running game with this name, player, folder or pid (case does not matter), and its address. */
  find(wanted: string): (Instance & { target: BridgeTarget }) | undefined {
    const want = wanted.trim().toLowerCase();
    if (!want) return undefined;
    return this.scan().find((i) =>
      [i.name, i.player, i.gameDir, i.pid !== undefined ? String(i.pid) : undefined].some((v) => v !== undefined && v.toLowerCase() === want),
    );
  }

  read(): BridgeTarget | undefined {
    if (this.instance) return this.find(this.instance)?.target;
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
