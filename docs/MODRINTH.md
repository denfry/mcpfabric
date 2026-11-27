# Modrinth listing for MCP Fabric

This file is the canonical copy and settings checklist for
[MCP Fabric on Modrinth](https://modrinth.com/mod/mcpfabric).

## Project settings

| Field | Value |
| --- | --- |
| Project ID | `eA63YgUh` |
| Slug | `mcpfabric` |
| Project type | Mod |
| License | MIT |
| Categories | Game Mechanics, Management, Utility |
| Client side | Optional |
| Server side | Optional |
| Source | `https://github.com/denfry/mcpfabric` |
| Issues | `https://github.com/denfry/mcpfabric/issues` |
| Icon | `docs/assets/mcpfabric-icon-512.png` |

Client and server are both **optional**, not required: install on the client when the AI should play
as the local player, on a dedicated server when it should act as an operator, or on both.

## Summary

Lets Claude or any other MCP client play Minecraft, build, and run a server. Fabric and NeoForge, Minecraft 1.21.1 to 26.3, 114 tools.

## Description

MCP Fabric connects Minecraft to AI agents through the [Model Context Protocol](https://modelcontextprotocol.io). The mod runs a small HTTP bridge inside the game, and an MCP server turns it into tools that Claude Desktop, Claude Code or any other MCP client can call. The agent can play as your character, read the world, or act as an operator on a server.

### What the agent can do

On a client it walks and pathfinds, mines, places blocks, fights, crafts, opens chests and takes screenshots. It reads blocks, entities, chat and game events, and gets a short text description of what is in view. On a server it edits the world, runs commands, changes time and weather, and manages players.

The MCP server adds an agent runtime on top. Memory, goals and a map of explored chunks are kept per world between sessions. Long actions such as travelling, exploring, gathering blocks, crafting a chain of recipes and building a structure run as background jobs. Builds can be imported from and exported to WorldEdit `.schem` files. For a long sequence of calls the agent can write one script and save it as a skill to reuse later.

New in 1.0.0:

- `mcpfabric-test`, end-to-end tests for servers, mods and plugins played by the real client, with JUnit reports. Tests can be recorded by playing.
- Developer tools: the game log, crash reports, loaded mods, registries, tick freeze and step, block changes in a region, and what a mob's AI is doing.
- Shop menus from plugins: item names and lore are shown to the agent, marked as text from the game, not instructions.
- Several games on one machine, and one MCP server that drives several bots at once.
- A compact tool set of 31 tools for small local models.

### Where to install it

| Installed on | What the agent can do |
| --- | --- |
| Client | Play as the local player: move, look, interact, inventory, navigation, screenshots |
| Dedicated server | Operate the world, entities, commands, events and players |
| Both | Everything the active side allows |

There is a separate jar for every Minecraft version. Fabric: 1.21.1 to 1.21.11 and 26.1 to 26.3, with Fabric Loader 0.19.5 or newer and the matching Fabric API. NeoForge: 1.21.1, 1.21.3 to 1.21.11, and 26.1.2 to 26.3.

### Install

1. Install Fabric Loader and Fabric API, or NeoForge.
2. Put the jar for your exact Minecraft version and loader in `mods/`.
3. Start the game. The mod writes its address and token to `~/.mcpfabric/bridge.json`, readable only by you, and the MCP server finds the game through it, so there is no token to copy.
4. Add the MCP server to your client: `npx -y mcpfabric-mcp-server`. The [quick start](https://github.com/denfry/mcpfabric#quick-start) has ready configs for Claude Desktop, Claude Code and others.

> The bridge gives an AI operator-level control of the game. It listens on `127.0.0.1` only and needs a token. Anything the agent should not do can be switched off in `config/mcpfabric.config.json`, and generic UI control and the developer tools are off until you turn them on. Read the [security policy](https://github.com/denfry/mcpfabric/blob/main/SECURITY.md) before exposing it beyond your own machine.

### Things to ask

- "Look around and tell me what is nearby."
- "Find iron, mine a stack and bring it back to the chest at home."
- "Build a 7 by 7 cobblestone house with a door facing the river."
- "Who is online, and what has been happening in chat?"

Source, documentation and releases are on [GitHub](https://github.com/denfry/mcpfabric).

## Gallery plan

Upload at least three original screenshots with descriptive captions:

1. **AI scene understanding** — Minecraft view beside the structured `describe_scene` result.
2. **Natural-language building** — prompt, in-progress structure, and finished result.
3. **114 MCP tools** — MCP Inspector or client tool list with Minecraft visible in the background.

Do not include bridge tokens, private paths, player chat, or server addresses in screenshots.
