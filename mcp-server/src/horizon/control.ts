/**
 * Client for Horizon's agent control socket (horizon-rust/horizon, `docs/agent-control.md`).
 *
 * Horizon is a Rust rewrite of Minecraft: Java Edition; Java mods do not run in it, so instead of
 * the mod's HTTP bridge the MCP server talks to the control endpoint the game itself opens when
 * Agent Control is on. Each connection sends one command per text line and reads one JSON line per
 * command, in order. Two transports carry the same lines:
 *
 * - a Unix domain socket (Linux, macOS), `horizon-control.sock` in the user's runtime directory;
 * - where there is none (Windows), or when the endpoint path ends in `.json`, a localhost TCP port:
 *   the game writes `{"transport":"tcp","port":N,"token":"..."}` to the path (readable only by its
 *   user) and the first line of a connection must be `auth TOKEN`.
 *
 * The game closes the endpoint while the player's "No AI" switch is on, so a refused connection is
 * the expected answer then, not an error to work around.
 */
import { readFileSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where a running game listens. */
export type ControlEndpoint = { kind: "tcp"; port: number; token: string } | { kind: "unix"; path: string };

/** A reply line, parsed. Horizon answers errors as `{"error": "...", "kind"?: "..."}`. */
export type ControlReply = Record<string, unknown>;

/** The control endpoint answered a command with an error. */
export class ControlError extends Error {
  constructor(
    message: string,
    /** Horizon's error kind when it gives one (`denied`, `busy`...), else `horizon_error`. */
    readonly kind: string,
  ) {
    super(message);
    this.name = "ControlError";
  }
}

/** The control endpoint could not be reached, or the connection broke mid-command. */
export class ControlUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlUnreachableError";
  }
}

/**
 * The endpoint path, the way Horizon resolves it (`control::default_path`): `$HORIZON_CONTROL`,
 * else `horizon-control.json` in the temporary directory on Windows, else `horizon-control.sock` in
 * `$XDG_RUNTIME_DIR`, else in `horizon-<uid>` under a shared `/tmp`, else in the temporary directory.
 */
export function defaultControlPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const explicit = env.HORIZON_CONTROL?.trim();
  if (explicit) return explicit;
  if (platform === "win32") return join(tmpdir(), "horizon-control.json");
  const runtime = env.XDG_RUNTIME_DIR?.trim();
  if (runtime) return join(runtime, "horizon-control.sock");
  const temp = tmpdir();
  try {
    // A temporary directory every user may write to (`/tmp`): Horizon uses a folder of this user's own.
    const shared = (statSync(temp).mode & 0o002) !== 0;
    const uid = process.getuid?.();
    if (shared && uid !== undefined) return join(temp, `horizon-${uid}`, "horizon-control.sock");
  } catch {
    // fall through to the temporary directory itself
  }
  return join(temp, "horizon-control.sock");
}

/** Reads the endpoint at `path`: a JSON file describing a TCP port, or a Unix socket path. */
export function readEndpoint(path: string, platform: NodeJS.Platform = process.platform): ControlEndpoint {
  const isFile = platform === "win32" || path.toLowerCase().endsWith(".json");
  if (!isFile) return { kind: "unix", path };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ControlUnreachableError(
      `Horizon's control endpoint ${path} does not exist: start Horizon with Agent Control on ` +
        "(Horizon Settings > AI Agent, or `horizon-ctl launch`), and make sure No AI is off in the launcher.",
    );
  }
  let parsed: { transport?: unknown; port?: unknown; token?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new ControlUnreachableError(`Horizon's control endpoint ${path} is not valid JSON.`);
  }
  const port = Number(parsed.port);
  if (parsed.transport !== "tcp" || !Number.isInteger(port) || port <= 0 || port > 65535 || typeof parsed.token !== "string" || !parsed.token) {
    throw new ControlUnreachableError(`Horizon's control endpoint ${path} does not describe a TCP port and token.`);
  }
  return { kind: "tcp", port, token: parsed.token };
}

/** Longest reply line accepted; Horizon's largest replies (a 32768-block box) stay far below. */
const MAX_REPLY = 32 << 20;

interface Pending {
  resolve: (reply: ControlReply) => void;
  reject: (err: Error) => void;
}

/**
 * One connection to the control endpoint. Replies come back in request order, so `send` queues;
 * a command that blocks in the game (goto, break...) holds the connection until it ends, which is
 * why the bridge keeps a second connection for those.
 */
export class ControlConnection {
  private buffer = "";
  private readonly pending: Pending[] = [];
  private closedError: Error | undefined;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err) => this.fail(new ControlUnreachableError(`Horizon's control connection failed: ${err.message}`)));
    socket.on("close", () => this.fail(new ControlUnreachableError("Horizon closed the control connection (the game exited, or Agent Control or No AI changed).")));
  }

  /** Connects (and authenticates over TCP) within `timeoutMs`. */
  static async open(endpoint: ControlEndpoint, timeoutMs: number): Promise<ControlConnection> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = endpoint.kind === "tcp" ? connect({ host: "127.0.0.1", port: endpoint.port }) : connect({ path: endpoint.path });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new ControlUnreachableError(`Horizon's control endpoint did not accept a connection within ${timeoutMs}ms.`));
      }, timeoutMs);
      s.once("connect", () => {
        clearTimeout(timer);
        s.removeAllListeners("error");
        resolve(s);
      });
      s.once("error", (err) => {
        clearTimeout(timer);
        reject(
          new ControlUnreachableError(
            `Could not reach Horizon's control endpoint (${err.message}). Is Horizon running with Agent Control on, and No AI off?`,
          ),
        );
      });
    });
    const conn = new ControlConnection(socket);
    if (endpoint.kind === "tcp") {
      const reply = await conn.sendRaw(`auth ${endpoint.token}`, timeoutMs);
      if (reply.ok !== true) {
        conn.close();
        throw new ControlUnreachableError("Horizon refused the control token (the game restarted: the endpoint file has a new one).");
      }
    }
    return conn;
  }

  get closed(): boolean {
    return this.closedError !== undefined;
  }

  /**
   * Sends one command line and resolves with its reply, rejecting with ControlError when the game
   * answered an error. `timeoutMs` bounds the wait; on timeout the connection is closed, because a
   * late reply would otherwise be taken as the answer to the next command.
   */
  async send(line: string, timeoutMs: number): Promise<ControlReply> {
    const reply = await this.sendRaw(line, timeoutMs);
    if (typeof reply.error === "string") throw new ControlError(reply.error, typeof reply.kind === "string" ? reply.kind : "horizon_error");
    return reply;
  }

  private sendRaw(line: string, timeoutMs: number): Promise<ControlReply> {
    if (/[\r\n]/.test(line)) return Promise.reject(new Error("a control command must be a single line"));
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise<ControlReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new ControlUnreachableError(`Horizon did not answer \`${line.split(" ")[0]}\` within ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.push({
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket.write(line + "\n");
    });
  }

  close(): void {
    this.fail(new ControlUnreachableError("control connection closed"));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_REPLY) {
      this.fail(new ControlUnreachableError("Horizon sent a reply line longer than the client accepts."));
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      const waiter = this.pending.shift();
      if (!waiter) continue; // nothing asked: ignore rather than misattribute it later
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        waiter.reject(new ControlError("Horizon sent a reply that is not JSON.", "bad_response"));
        continue;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        waiter.reject(new ControlError("Horizon sent a reply that is not a JSON object.", "bad_response"));
        continue;
      }
      waiter.resolve(parsed as ControlReply);
    }
  }

  private fail(err: Error): void {
    if (this.closedError) return;
    this.closedError = err;
    for (const p of this.pending.splice(0)) p.reject(err);
    this.socket.destroy();
  }
}

/** Word for a command line: refuses anything that could split the line or the word. */
export function word(value: string, what: string): string {
  if (!/^[A-Za-z0-9_.:\-/+[\]=,#~^]+$/.test(value)) throw new Error(`${what} has characters Horizon's control commands cannot carry: ${JSON.stringify(value)}`);
  return value;
}

/** Number for a command line. */
export function num(value: unknown, what: string): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`${what} must be a finite number`);
  return String(n);
}

/** Free text for the end of a command line (chat, commands): one line, no control characters. */
export function rest(value: string, what: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${what} must be one line without control characters`);
  return value;
}
