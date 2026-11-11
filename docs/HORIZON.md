# Horizon backend

[Horizon](https://github.com/horizon-rust/horizon) is a rewrite of Minecraft: Java Edition 26.3 in
Rust. It runs no Java mods, so the mcpfabric mod cannot be installed there. Instead, the MCP server
drives the agent control socket that Horizon itself opens, and offers the same tools, agent runtime
and scripts on top of it.

```
MCP client ──stdio/HTTP──▶ mcpfabric MCP server ──control socket──▶ Horizon (game)
                           (MCPFABRIC_BACKEND=horizon)   localhost TCP + token / Unix socket
```

## Setup

1. Install Horizon with its launcher and play a world once.
2. Let agents in: in Horizon, **Settings > AI Agent > Agent Control** on (or start the game with
   `horizon-ctl launch`). The launcher's **No AI** switch must be off.
3. Run the MCP server with the Horizon backend, for example in Claude Code:

   ```bash
   claude mcp add mcpfabric-horizon -e MCPFABRIC_BACKEND=horizon -- npx -y mcpfabric-mcp-server
   ```

The server finds the game where Horizon puts its endpoint: `%TEMP%\horizon-control.json` on Windows
(a localhost port and a token), `$XDG_RUNTIME_DIR/horizon-control.sock` on Linux and macOS. Set
`HORIZON_CONTROL` when the game was started with another path. The endpoint is read again on every
reconnect, so a restarted game is found without restarting the MCP server.

## What works

| Area | Tools |
|------|-------|
| Status, session | `get_status`, `list_capabilities`, `get_screen`, `close_screen` (also respawns), `list_worlds`, `join_world` |
| Local player | `get_self`, `get_inventory`, `get_equipment`, `get_status_effects` |
| Movement | `set_movement`, `stop_movement`, `look`, `look_at`, `jump`, `navigate_to`, `navigation_status`, `stop_navigation` |
| Interaction | `break_block`, `place_block`, `use_item`, `start_using_item`, `stop_using_item`, `attack_entity`, `use_entity`, `drop_held_item`, `select_hotbar_slot`, `swap_slots` |
| World | `get_block`, `get_blocks_region`, `find_blocks`, `get_time_and_weather`, `set_block`, `fill_blocks`, `set_time`, `set_weather` |
| Entities, operator | `query_entities`, `summon_entity`, `give_item`, `apply_effect`, `teleport_player`, `set_gamemode`, `run_command` |
| Chat, events, vision | `send_chat`, `get_recent_chat`, `poll_events`, `screenshot` |
| Agent runtime | `agent_brief`, `observe`, `surroundings`, `map_view`, memory and goals, `travel_to`, `explore`, `collect_blocks`, `build_*` (with `method: "set"`), `open_container`, `container_transfer`, `close_container`, jobs |
| Code mode | `run_script`, skills, dashboard |
| UI (opt-in) | `get_ui`, `click_widget` with `MCPFABRIC_HORIZON_UI=1` |

Operator tools run as commands, so they need a world with cheats on (or an operator on a server).

## What does not (yet)

Horizon's control socket has no equivalent for these, so they are not offered on this backend:
`plan_craft`, `get_recipes`, `craft_item` (no recipe access), `describe_scene`, `raycast`,
`place_block_at`, `show_message`, `list_dimensions`, `get_entity`, `remove_entity`, `list_players`,
`get_player`, `message_player`, `kick_player`, `drop_slot`, `set_text_field` and the supervised
mode. `get_status` lists the methods served (`methods`).

## Differences from the mod

- **Gating.** The mod's `enable*` locks live in the mod's config, which Horizon does not have.
  Horizon's own switches decide instead: the socket exists only while Agent Control is on, and the
  No AI switch closes it. UI control stays off unless `MCPFABRIC_HORIZON_UI=1`.
- **Navigation.** Horizon's walker walks, jumps one block, drops up to three blocks and swims. It
  does not dig or pillar, so `allowDig` and `allowPillar` have no effect; the agent's travel jobs
  route around obstacles with waypoints.
- **Entity ids.** `uuid` fields hold Horizon's numeric entity ids (from `query_entities`).
- **Chat has no sender.** Horizon does not say who wrote a chat line. All chat is untrusted, and the
  Claude Code channel never takes a chat line as a request from the local player.
- **Scan size.** `observe` reads blocks over the socket and covers at most 3 chunks around the
  player, 20 blocks below to 12 above.
- **One dimension.** World tools act in the player's dimension; a `dimension` argument naming
  another one is refused.
- **Server ids.** A server's `worldId` is a keyed hash of its address; the key is
  `horizon-world.key` in the data directory (`~/.mcpfabric`), so addresses never reach the model.

Horizon's control commands are a preview API without a version of their own (`docs/api/stability.md`
in Horizon). This backend was tested against Horizon `nightly-2026-11-08` (control protocol 0.1.0).
