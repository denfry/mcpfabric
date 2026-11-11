/**
 * The supervisor session of this MCP server (issue #27).
 *
 * The mod accepts supervised requests only with the id of its current supervisor session and a
 * sequence number larger than the last one it saw, so a stale or replayed request is refused. The
 * session is opened on the first supervised call and its id stays here: the model never sees it.
 * Calls run one at a time, in order, because each one is a single approved action.
 */
import { BridgeError, type GameBridge } from "./bridge.js";

export class SupervisedSession {
  private id: string | undefined;
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly bridge: GameBridge) {}

  /** Forwards one supervised request with the session id and the next sequence number. */
  call(method: string, args: Record<string, unknown>): Promise<unknown> {
    const run = this.queue.then(() => this.send(method, args));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Ends the session (when the MCP client disconnects); fences its outstanding grants in the mod. */
  async end(): Promise<void> {
    const id = this.id;
    this.id = undefined;
    if (id) await this.bridge.call("supervised.end", { session: id }).catch(() => undefined);
  }

  private async send(method: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.id) {
      const opened = await this.bridge.call<{ session: string }>("supervised.begin");
      this.id = opened.session;
      this.seq = 0;
    }
    try {
      return await this.bridge.call(method, { ...args, session: this.id, seq: ++this.seq });
    } catch (err) {
      // Another supervisor took over (or the game restarted): the next call opens a new session.
      if (err instanceof BridgeError && (err.code === "stale_session" || err.code === "no_session")) this.id = undefined;
      throw err;
    }
  }
}
