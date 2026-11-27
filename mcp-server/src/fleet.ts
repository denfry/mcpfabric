/**
 * Several games from one MCP server (MCPFABRIC_MULTI_CLIENT): every tool takes an optional
 * `client`, the name of a running game from `list_clients`, and acts in that game; without it the
 * tool acts in the default game, as with a single game. Each game gets its own bridge client, body,
 * job manager and script host, so a job in one game never drives the player of another. The agent
 * database is shared: bots in the same world share memory, goals and the map.
 *
 * Games are found through the instance files the mod writes (discovery.ts), so this needs the token
 * from those files, not MCPFABRIC_TOKEN.
 */
import { z } from "zod";

import type { BridgeClient } from "./bridge.js";
import type { BridgeTarget, Instance } from "./discovery.js";
import type { AgentRuntime } from "./agent/runtime.js";
import type { ScriptHost } from "./script/tools.js";

/** At most this many games are driven at once besides the default one. */
export const MAX_CLIENTS = 8;

/** One game and what drives it. */
export interface Member {
  /** Instance name; undefined for the default game. */
  name: string | undefined;
  bridge: BridgeClient;
  runtime?: AgentRuntime;
  scripts?: ScriptHost;
}

/** What the fleet needs from discovery. */
export interface InstanceSource {
  instances(): Instance[];
  find(wanted: string): (Instance & { target: BridgeTarget }) | undefined;
}

export const CLIENT_DESCRIPTION =
  "Name of the game to act in, from list_clients. Leave it out for the default game.";

/** The `client` parameter every tool takes in multi-client mode. */
export const clientParam = z.string().min(1).max(80).optional().describe(CLIENT_DESCRIPTION);

/** A tool schema with the `client` parameter added. */
export function withClient(shape: z.ZodRawShape): z.ZodRawShape {
  if ("client" in shape) throw new Error("a tool already has a parameter named client");
  return { ...shape, client: clientParam };
}

/** Splits the `client` parameter off a tool's arguments. */
export function splitClient(args: Record<string, unknown> | undefined): { client: string | undefined; rest: Record<string, unknown> } {
  const { client, ...rest } = args ?? {};
  return { client: typeof client === "string" && client.trim() ? client.trim() : undefined, rest };
}

export class Fleet {
  /** Members of named games, by the address of their bridge (one per running game). */
  private readonly named = new Map<string, Member>();

  /**
   * @param main the default game: the bridge and runtime the server uses without `client`
   * @param make builds the member of a named game, talking to `target`
   */
  constructor(
    private readonly source: InstanceSource,
    readonly main: Member,
    private readonly make: (name: string, target: BridgeTarget) => Member,
  ) {}

  /**
   * The running games, newest first. `client` is what to pass as `client`: the game's name, or its
   * process id when two games share a name. `default` marks the game tools act in without `client`.
   */
  list(): { client: string; player?: string; default: boolean }[] {
    const defaultUrl = this.main.bridge.target().url;
    const instances = this.source.instances();
    const count = new Map<string, number>();
    for (const i of instances) count.set(i.name.toLowerCase(), (count.get(i.name.toLowerCase()) ?? 0) + 1);
    return instances.map((i) => ({
      client: count.get(i.name.toLowerCase())! > 1 && i.pid !== undefined ? String(i.pid) : i.name,
      ...(i.player ? { player: i.player } : {}),
      default: i.url === defaultUrl,
    }));
  }

  /** The member for `client`; the default game without it. Throws when no running game has that name. */
  async resolve(client: string | undefined): Promise<Member> {
    if (client === undefined) return this.main;
    const found = this.source.find(client);
    if (!found) {
      const names = this.list().map((i) => i.client);
      throw new Error(`no running game named "${client}"; running now: ${names.length ? names.join(", ") : "none"} (see list_clients)`);
    }
    await this.forgetStopped();
    const url = found.target.url;
    // The default game has one body: a member made for it while it was not the default goes.
    if (url === this.main.bridge.target().url) {
      await this.drop(url);
      return this.main;
    }
    let member = this.named.get(url);
    if (!member) {
      if (this.named.size >= MAX_CLIENTS) throw new Error(`at most ${MAX_CLIENTS} games besides the default one can be driven at once`);
      member = this.make(found.name, found.target);
      this.named.set(url, member);
    }
    return member;
  }

  /** Every member made so far, the default one first. */
  members(): Member[] {
    return [this.main, ...this.named.values()];
  }

  /** Drops the members of games that are no longer running (a restarted game gets a new member). */
  private async forgetStopped(): Promise<void> {
    const running = new Set(this.source.instances().map((i) => i.url));
    for (const url of [...this.named.keys()]) if (!running.has(url)) await this.drop(url);
  }

  private async drop(url: string): Promise<void> {
    const member = this.named.get(url);
    if (!member) return;
    this.named.delete(url);
    member.scripts?.cancelAll();
    await member.runtime?.jobs.cancel().catch(() => undefined);
    member.runtime?.close();
  }
}
