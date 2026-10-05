# Instructions for AI coding agents

This file is for agents working **on** the mcpfabric source tree (Claude Code, Codex, Cursor,
Copilot, Gemini CLI, ...). It is not about the in-game agent runtime; for that see
[docs/AGENT.md](docs/AGENT.md). Humans: [CONTRIBUTING.md](CONTRIBUTING.md) is the full guide and
wins on any conflict.

## What this is

A Minecraft mod (Fabric and NeoForge, 1.21.1 and newer, one source tree built with Stonecutter) that
runs a local HTTP bridge, plus `mcp-server/`, a TypeScript MCP server that talks to the bridge. The
bridge gives an AI **operator-level control** of a game. Treat every change as security-relevant.

## Where things live

- `src/main/java` shared code (client and dedicated server); `src/client/java` client-only code.
- Handlers register RPC methods on `RpcRouter`; `src/main/java/dev/mcpfabric/handlers/support/Gates.java`
  holds the capability locks (`enable*` flags in `mcpfabric.config.json`).
- `mcp-server/src/tools.ts` is the single source of truth for the MCP tool catalogue;
  `mcp-server/src/agent/` is the agent runtime (memory, goals, jobs, world map).
- `versions/<node>/gradle.properties` are per-node versions; `settings.gradle` declares the nodes.

## Rules for code changes

1. **Loader isolation.** Shared code talks to vanilla Minecraft only. Anything from `net.fabricmc` or
   `net.neoforged` must sit in a package named after the loader (`dev.mcpfabric.fabric`,
   `dev.mcpfabric.neoforge`, `dev.mcpfabric.client.fabric`, `dev.mcpfabric.client.neoforge`); each node
   excludes the other loader's packages. A new game event is one hook in the shared class plus one
   subscription per loader. Never ship a feature for one loader only without saying so.
2. **Every RPC method is gated.** A method that belongs to a capability group calls the matching
   `Gates.*` (or `requireControl()` in client handlers) first, and `info.capabilities` / `info.status`
   must report that group the same way. Read methods count: anything that reveals the world (entities,
   blocks, containers, addresses, names) is vision or control, not "free". If a method is deliberately
   always on, say why in the PR.
3. **New or renamed RPC method:** add or update the entry in `mcp-server/src/tools.ts`, the tool list
   in `README.md`, `docs/AGENT.md` if it concerns the runtime, the contract test in
   `mcp-server/test/`, and `CHANGELOG.md` under `[Unreleased]`.
4. **Threads.** Game state is touched on the game thread only (`MainThread.call`). A bridge handler that
   waits holds a bridge thread; SSE streams are capped (`SseHub.MAX_SUBSCRIBERS`), so never block
   without a bound, and `SseHub.register` can return `null`. Register a subscriber before checking
   the event buffer, or events are lost.
5. **Secrets and privacy.** The token and `worldIdKey` never go over the bridge, into logs, events,
   tool results or `agent.db`. Do not return server addresses, server list names, or other
   identifying data to the model; use opaque ids.
6. **Stonecutter.** Keep the uncommented branch on the newest API and the commented one on the older
   API. Do not write a conditional whose branches are identical. Use narrow version ranges.
7. **Style.** Tabs in Java; follow the existing formatting in TypeScript. Match surrounding code, keep
   diffs focused, no drive-by refactors, no unrelated formatting or line-ending changes.

## Verify before you say it works

- `cd mcp-server && npm run typecheck && npm test`
- Java tests on one node of each loader: `./gradlew ":1.21.1:test" ":1.21.1-neoforge:test"`
- Compilation of the whole matrix is `./gradlew chiseledBuild` (27 nodes). It needs JDK 25 for
  Gradle (JDK 21 for building only 1.21.x) and a lot of memory; if the machine is tight, run
  `./gradlew --stop` first and rely on CI for the full matrix. Say which checks you ran and which you
  did not. Never claim a loader or version builds without compiling it.
- Behaviour that needs the game (perception, containers, HUD) has to be run in a dev client
  (`./gradlew :<node>:runClient`) or reported as untested.

## Git, PRs and releases

- Branch from `main`; `main` is protected: changes go through a pull request with green CI. Never
  push to `main`, force-push shared branches, or skip hooks.
- Conventional commit messages as in the history: `feat:`, `fix:`, `docs:`, `chore:`, optional scope
  such as `fix(mcp-server):`. One logical change per commit and per PR; use
  `.github/pull_request_template.md`.
- **No AI attribution anywhere**: no `Co-Authored-By` trailers naming an AI, no "Generated with ..."
  lines, no mentions of an assistant in commits, PR text, code comments or release notes.
- Do not commit local files (`.claude/`, `build/`, `run/`, `.env`, `mcpfabric.config.json`, logs).
- **Releases are the maintainer's call.** Do not bump `mod_version`, create tags (`vX.Y.Z` releases
  Fabric, `neoforge-vX.Y.Z` releases NeoForge) or publish to Modrinth unless asked. When asked, follow
  [docs/RELEASING.md](docs/RELEASING.md). Re-running a release after Modrinth succeeded fails on
  duplicate versions.

## Security

- Vulnerabilities are reported privately (see [SECURITY.md](SECURITY.md)). Never describe an
  unreleased vulnerability in a public issue, PR, commit message, changelog entry or test name before
  the fix is released; use neutral wording ("require X for Y") until the advisory is published.
- Do not weaken the bridge defaults: `127.0.0.1` binding, bearer token, JSON `Content-Type` and the
  no-`Origin` check, the `enable*` locks.
- Do not add telemetry or outbound network calls without the maintainer; [docs/TELEMETRY.md](docs/TELEMETRY.md) lists the requirements.

## When unsure

Ask the maintainer instead of guessing on: new capability flags, bridge protocol changes, new
dependencies, supported-version changes, and anything that changes what a model can see or do in the
game.
