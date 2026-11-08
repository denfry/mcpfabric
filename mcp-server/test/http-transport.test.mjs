import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Runs against the compiled server: npm run build first (npm test does).
const serverEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

let child;
let port;
let exited = null;

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port: p } = s.address();
  await new Promise((r) => s.close(r));
  return p;
}

/** One HTTP request to the server under test; resolves with the status code. */
function request(method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(body);
  });
}

before(async () => {
  port = await freePort();
  child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      MCPFABRIC_TRANSPORT: "http",
      MCPFABRIC_HTTP_PORT: String(port),
      MCPFABRIC_AGENT: "0",
      MCPFABRIC_SCRIPTS: "0",
      MCPFABRIC_TOKEN: "test-token",
      MCPFABRIC_URL: "http://127.0.0.1:9",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.on("exit", (code) => (exited = code));
  let stderr = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${stderr}`)), 10_000);
    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.includes("transport ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
});

after(() => {
  child?.kill();
});

test("a client that hangs up in the middle of a request body does not stop the server", async () => {
  await new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n` +
          `Accept: application/json, text/event-stream\r\nContent-Length: 1000\r\n\r\n{"jsonrpc":`,
      );
      setTimeout(() => {
        sock.destroy();
        resolve();
      }, 100);
    });
    sock.on("error", () => {});
  });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(exited, null, "the server exited");
  // Still answering: a local GET without a session is refused by the transport, but answered.
  const status = await request("GET", { host: `127.0.0.1:${port}`, accept: "text/event-stream" });
  assert.ok(status >= 400 && status < 500, `unexpected status ${status}`);
});

test("a request body over the limit is refused with 413", async () => {
  // The declared length is enough to refuse it, before any of the body is read.
  const status = await request("POST", {
    host: `127.0.0.1:${port}`,
    "content-type": "application/json",
    "content-length": String(5 * 1024 * 1024),
  });
  assert.equal(status, 413);
  assert.equal(exited, null, "the server exited");
});

test("a request naming another host is refused (DNS rebinding)", async () => {
  const status = await request("GET", { host: `evil.example:${port}` });
  assert.equal(status, 403);
});
