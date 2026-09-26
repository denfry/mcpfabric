# Wishlist: what the bridge was missing in real use

Gathered on 2026-09-26 while driving a NeoForge 1.21.1 modpack client (Terra: Incognita, TerraFirmaCraft,
~160 mods) through the bridge to check a cooking feature in a real survival world. Ordered by how badly
each gap blocked the check.

**Status (0.5.0, unreleased):** 1–12 and 17 are implemented; 13–16 are still open.

| # | Implemented as |
|---|----------------|
| 1 | `ui.closeScreen` (`close_screen`), `input.pressKey` (`press_key`, with `holdTicks` and modifiers) |
| 2 | `ui.typeText` (`type_text`, optional Enter), `ui.focus` (`focus_widget`) |
| 3 | `ui.getScreen` (`get_screen`), `ui.clickWidget` (`click_widget`), `ui.clickSlot` (`click_slot`) |
| 4 | `world.listSaves`, `world.joinSingleplayer`, `world.create` (any registry world preset), `world.leave` |
| 5 | NeoForge jars declare the first build of their line, e.g. `[21.1.0,)` |
| 6 | `player.getTooltip` (`get_tooltip`) |
| 7 | `sneak: true` on `interact.placeBlock` / `interact.useItem` |
| 8 | `interact.holdUse` (`hold_use`), `interact.consumeHeld` (`consume_held`) |
| 9 | `player.getTarget` (`get_target`); `world.raycast` defaults to the player's eyes and look |
| 10 | `world.insertItem` (`insert_item`), `world.getBlockInventory` (`get_block_inventory`) |
| 11 | `client.setWindow`, `client.setGuiScale`, `client.setLanguage`, `client.setHudHidden` |
| 12 | config `keepRunningUnfocused` (default on) and `client.setPauseOnLostFocus` |
| 17 | the bridge tries the next ten ports, logs `port X busy, trying Y`, writes the port back |

## Blockers

1. **Close the open screen / press a key.** A right-click opened a block's GUI and nothing in the API could
   close it; a human had to press Esc. Wanted: `ui.closeScreen`, and more generally `input.pressKey`
   (Esc, E, F1, F3, number keys, with hold duration).
2. **Type into text fields.** A mod opens a "who are you?" screen with a name field on first join, and the
   agent could not get past it. Wanted: `ui.typeText` into the focused widget, `ui.focus(widget)`.
3. **Read and drive the current screen.** No way to know which screen is open other than a screenshot.
   Wanted: `ui.getScreen` (class, title, widgets with type/label/bounds/enabled, container slots with stacks),
   `ui.clickWidget(index|label)`, `ui.clickSlot(slot, button, shift)`.
4. **Enter a world from the title screen.** The client can only be pointed at a world by the launcher
   (`--world`). Wanted: `world.listSaves`, `world.joinSingleplayer(name)`, `world.create(name, preset/level
   type, gamemode, cheats, seed)`, `world.leave`.
5. **Loader range.** The 1.21.1 NeoForge jar declares `neoforge [21.1.251,)`; packs pinned to 21.1.249 (and
   older 21.1.x) refuse it, so it has to be repacked by hand. `[21.1.0,)` works.

## Would have saved a lot of guessing

6. **Item tooltips.** `get_inventory` gives id, count and name only. Many mods put the interesting state in
   the tooltip (quality, composition, decay date). Wanted: `player.getTooltip(slot, advanced)` returning the
   rendered lines as text.
7. **Sneak-use in one call.** Shift + right-click on a block needs `set_movement{sneak}` →
   `place_block` → release, and the order is racy. Wanted: `sneak: true` on `interact.placeBlock` /
   `interact.useItem`.
8. **Use-and-hold on a target for a duration.** `start_using_item` uses whatever the crosshair hits.
   Wanted: `interact.holdUse(x, y, z, face, ticks)`, and the same for eating/drinking to completion
   (`interact.consumeHeld`), returning what changed (hunger, item left in hand).
9. **Raycast from the player by default.** `raycast` requires `origin`; the common question is "what is under
   my crosshair". Wanted: `player.getTarget` (block pos, face, block id, entity).
10. **Insert into modded block inventories.** `/item replace block` fails on blocks that expose only an
    item-handler capability (all TerraFirmaCraft devices). Wanted: `world.insertItem(x, y, z, side, item,
    count)` / `world.getBlockInventory` through the loader's item-handler capability.
11. **Window, GUI scale and language.** Layout checks need several window sizes, every GUI scale and both
    languages. Wanted: `client.setWindow(width, height)`, `client.setGuiScale(n)`,
    `client.setLanguage(code)` (with resource reload), `client.setHudHidden(bool)` for clean screenshots.
12. **Screenshot without the pause screen.** An unfocused window pauses and every screenshot shows the pause
    menu unless `pauseOnLostFocus:false` is set by hand. Wanted: the bridge disables pause-on-focus-loss while
    it is controlling the client, or a `client.setPauseOnLostFocus(false)`.

## Nice to have

13. **Sounds and particles as events.** To check "stirring plays a sound and makes steam" there is only the
    screenshot. Wanted: `sound_played` / `particle_spawned` events near the player (id, position), filterable.
14. **Action bar as its own stream.** Overlay messages come through `get_recent_chat` with `overlay: true`,
    which works; a `get_action_bar` (current text + time) would make polling simpler.
15. **Wait primitives.** `wait.until(block state|chat text|screen class, timeoutMs)` instead of client-side
    sleep loops.
16. **Command output encoding.** `command.run` output is correct UTF-8 in JSON, but examples should say that
    Windows consoles need `PYTHONIOENCODING=utf-8` (or equivalent) or Cyrillic turns into `?`.
17. **Default port clash.** Another dev agent in the same pack also defaults to 25599. A startup log line
    that says "port busy, trying 25600" (with the chosen port written back to the config) would avoid a
    silent failure.
