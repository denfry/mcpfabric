#!/usr/bin/env node
/**
 * mcpfabric-test: end-to-end tests for Minecraft servers, mods and plugins, played by the real
 * client through mcpfabric. See docs/TESTING.md.
 *
 *   mcpfabric-test [files or directories...] [options]
 *
 * Finds the game like the MCP server does (MCPFABRIC_TOKEN or ~/.mcpfabric/bridge.json). Exit code:
 * 0 when every test passed, 1 when one failed, 2 when the run could not start.
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Bridge, SessionInfo } from "../agent/body.js";
import { BridgeClient } from "../bridge.js";
import { loadConfig } from "../config.js";
import { defaultDiscoveryPath, Discovery } from "../discovery.js";
import { formatResult, formatSummary, jsonReport, junit, summarize } from "./report.js";
import { displayPath, findTestFiles, TestRunner, type TestResult } from "./runner.js";

const USAGE = `usage: mcpfabric-test [files or directories...] [options]

Runs *.mctest.js files (directories are searched; default: the current directory) against the
running game.

options:
  --grep <text>        only tests whose "file > name" contains the text
  --list               list the tests without running them
  --retries <n>        run a failed test up to n more times (default 0)
  --timeout <ms>       time limit of a test (default 30000; test(name, fn, { timeout }) wins)
  --hook-timeout <ms>  time limit of each hook (default 30000)
  --world <id>         refuse to run unless the game is in this world (see: mcpfabric-test --world-id)
  --world-id           print the id of the world the game is in
  --param key=value    a value the tests read as params.key (repeatable)
  --junit <file>       write a JUnit XML report
  --json <file>        write a JSON report
  --artifacts <dir>    where failed tests leave a screenshot and context.json (default mctest-results)
  --no-artifacts       keep nothing for failed tests
  --no-screenshots     keep context.json but no screenshot
  --bail               stop after the first failed test
`;

interface Cli {
  paths: string[];
  grep?: string;
  list: boolean;
  retries: number;
  timeoutMs?: number;
  hookTimeoutMs?: number;
  world?: string;
  worldId: boolean;
  params: Record<string, string>;
  junit?: string;
  json?: string;
  artifacts?: string;
  screenshots: boolean;
  bail: boolean;
  help: boolean;
}

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["--grep", "--retries", "--timeout", "--hook-timeout", "--world", "--param", "--junit", "--json", "--artifacts"]);

export function parseArgs(argv: string[]): Cli {
  const cli: Cli = { paths: [], list: false, retries: 0, worldId: false, params: {}, artifacts: "mctest-results", screenshots: true, bail: false, help: false };
  const int = (flag: string, v: string, min: number): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) throw new UsageError(`${flag} takes a whole number of at least ${min}, got "${v}"`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      cli.paths.push(a);
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      switch (a) {
        case "--grep":
          cli.grep = v;
          break;
        case "--retries":
          cli.retries = int(a, v, 0);
          break;
        case "--timeout":
          cli.timeoutMs = int(a, v, 1);
          break;
        case "--hook-timeout":
          cli.hookTimeoutMs = int(a, v, 1);
          break;
        case "--world":
          cli.world = v;
          break;
        case "--param": {
          const eq = v.indexOf("=");
          if (eq <= 0) throw new UsageError(`--param takes key=value, got "${v}"`);
          cli.params[v.slice(0, eq)] = v.slice(eq + 1);
          break;
        }
        case "--junit":
          cli.junit = v;
          break;
        case "--json":
          cli.json = v;
          break;
        case "--artifacts":
          cli.artifacts = v;
          break;
      }
      continue;
    }
    switch (a) {
      case "--list":
        cli.list = true;
        break;
      case "--world-id":
        cli.worldId = true;
        break;
      case "--no-artifacts":
        cli.artifacts = undefined;
        break;
      case "--no-screenshots":
        cli.screenshots = false;
        break;
      case "--bail":
        cli.bail = true;
        break;
      case "--help":
        cli.help = true;
        break;
      default:
        throw new UsageError(`unknown option ${a}`);
    }
  }
  return cli;
}

function bridgeFromEnv(): Bridge {
  const cfg = loadConfig();
  const discovery = cfg.token ? undefined : new Discovery(defaultDiscoveryPath());
  return new BridgeClient(cfg.bridgeUrl, cfg.token, cfg.timeoutMs, discovery ? () => discovery.read() : undefined);
}

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export async function main(argv: string[], bridge: () => Bridge = bridgeFromEnv, print: (line: string) => void = console.log): Promise<number> {
  const cli = parseArgs(argv);
  if (cli.help) {
    print(USAGE);
    return 0;
  }
  if (cli.worldId) {
    print((await bridge().call<SessionInfo>("session.info")).worldId);
    return 0;
  }
  const files = findTestFiles(cli.paths.length > 0 ? cli.paths : ["."]);
  if (files.length === 0) {
    print(`no *.mctest.js files in ${cli.paths.length > 0 ? cli.paths.join(", ") : "the current directory"}`);
    return 2;
  }
  const b = bridge();
  const runner = new TestRunner(b, {
    ...(cli.grep ? { grep: cli.grep } : {}),
    retries: cli.retries,
    ...(cli.timeoutMs !== undefined ? { timeoutMs: cli.timeoutMs } : {}),
    ...(cli.hookTimeoutMs !== undefined ? { hookTimeoutMs: cli.hookTimeoutMs } : {}),
    ...(cli.artifacts ? { artifactsDir: cli.artifacts } : {}),
    screenshots: cli.screenshots,
    bail: cli.bail,
    params: cli.params,
    onFileStart: (file) => print(displayPath(file)),
    onResult: (r: TestResult) => {
      for (const line of formatResult(r)) print(line);
    },
  });

  if (cli.list) {
    let n = 0;
    for (const file of files) {
      print(displayPath(file));
      const listed = await runner.list(file);
      for (const t of listed.tests) {
        if (cli.grep && !`${displayPath(file)} > ${t.name}`.includes(cli.grep)) continue;
        n++;
        print(`  ${t.name}${t.skip ? "  (skip)" : ""}${t.only ? "  (only)" : ""}`);
      }
    }
    print(`${n} tests`);
    return 0;
  }

  // Fails here, before any test, when the game cannot be reached.
  const info = await b.call<SessionInfo>("session.info");
  if (cli.world && info.worldId !== cli.world) throw new UsageError(`the game is in world ${info.worldId}, not ${cli.world}; refusing to run the tests there`);

  const t0 = Date.now();
  const results = await runner.run(files);
  const ms = Date.now() - t0;
  if (cli.junit) write(cli.junit, junit(results, ms));
  if (cli.json) write(cli.json, jsonReport(results, ms));
  const s = summarize(results, ms);
  print("");
  print(formatSummary(s));
  return s.failed > 0 ? 1 : 0;
}

/** Run only as the program (also through an npm bin link), not when the tests import this module. */
function isMain(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`mcpfabric-test: ${(err as Error).message}`);
      if (err instanceof UsageError) console.error("run mcpfabric-test --help for the options");
      process.exit(2);
    },
  );
}
