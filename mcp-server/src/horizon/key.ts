/**
 * The secret behind opaque server ids (`mp:...`) on Horizon. The mod keeps its own `worldIdKey` in
 * the game's config; Horizon has no place for one, so the MCP server keeps a random key beside the
 * agent database, readable only by its user. Without a secret, an id would be a plain hash of the
 * address, which anyone could reverse by hashing candidate addresses.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let cached: { path: string; key: Buffer } | undefined;

export function horizonWorldKey(dataDir?: string): Buffer {
  const dir = dataDir || join(homedir(), ".mcpfabric");
  const path = join(dir, "horizon-world.key");
  if (cached?.path === path) return cached.key;
  let key: Buffer | undefined;
  try {
    const text = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(text)) key = Buffer.from(text, "hex");
  } catch {
    // made below
  }
  if (!key) {
    key = randomBytes(32);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // `wx`: never overwrite a key another process wrote in the meantime; read that one instead.
    try {
      writeFileSync(path, key.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    } catch {
      const text = readFileSync(path, "utf8").trim();
      if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${path} is not a valid key; delete it to make a new one`);
      key = Buffer.from(text, "hex");
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows: the file lives in the user's profile
    }
  }
  cached = { path, key };
  return key;
}
