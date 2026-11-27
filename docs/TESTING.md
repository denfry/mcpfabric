# End-to-end tests with a real client

`mcpfabric-test` runs test files against the game you have open: a real Minecraft client with the
mod, in singleplayer or connected to any server. Tests see what a player sees: the rendered
screen, menus, chat, the inventory as the client has it. That is the part protocol bots and
mocked servers cannot check, such as a plugin's GUI built from custom fonts, a resource pack's
models, or a boss that a packet-level bot mistakes for a fake player.

```bash
cd mcp-server && npm run build
node dist/testing/cli.js examples --world sp:TestWorld
# or, from the published package
npx -p mcpfabric-mcp-server mcpfabric-test mctest/ --junit reports/junit.xml
```

```
examples/basics.mctest.js
  PASS  the player is in a world with no menu open  (0.1 s)
  PASS  a broadcast reaches the client's chat  (0.4 s)
  FAIL  given items show up in the client's inventory  (5.2 s)
        AssertionError: expected 0 to be 64 (polled 21 times for 5000 ms)
        at step: the client has them
        kept: mctest-results/examples-basics/03-given-items-show-up-in-the-client-s-inventory/screenshot.png
        kept: mctest-results/examples-basics/03-given-items-show-up-in-the-client-s-inventory/context.json
  PASS  a block placed by the server is there  (0.2 s)

3 passed, 1 failed (6.1 s)
```

The runner finds the game like the MCP server does (`MCPFABRIC_TOKEN`, or `~/.mcpfabric/bridge.json`
while the game runs) and exits with 0 when every test passed, 1 when one failed and 2 when the run
could not start (no game, bad options, the wrong world).

## Writing tests

A test file is JavaScript named `*.mctest.js`. It registers tests; the runner runs each one:

```js
beforeEach(async () => {
  await command("clear @p", { allowFail: true }); // fails when the inventory is already empty
});

test("the shop sells a sword", async ({ step }) => {
  await step("open the shop", async () => {
    await mc.send_chat({ message: "/shop" }); // typed by the player
    await waitFor(async () => (await mc.container_state()).open, { message: "the shop menu" });
  });
  await step("buy the sword", async () => {
    const menu = await mc.container_state();
    expect(menu.title).toContain("Shop");
    const sword = menu.slots.find((s) => s.id === "minecraft:diamond_sword");
    expect(sword, "the sword in the shop").toBeDefined();
    await mc.container_click({ slot: sword.slot });
  });
  await expect.poll(() => inventoryCount("diamond_sword")).toBe(1);
});
```

The game is reached through `mc`, exactly as in `run_script`: `mc.<tool name>(params)` for every
bridge tool of the catalogue (`mc.get_self()`, `mc.click_widget({ id })`, `mc.run_command(...)`),
or `mc.call("<tool or method>", params)`. Parameters are checked like the MCP tools check them.
Tests also get the menu methods the agent runtime uses: `mc.container_state()` (the open menu: title,
size, non-empty slots with `slot`, `id`, `count`), `mc.container_click({ slot, mode, button })`
(`mode` pickup, quick_move, throw or swap), `mc.container_open({ x, y, z })` and
`mc.container_close()`. Supervised methods are not available. The mod's capability locks
(`enable*` in `mcpfabric.config.json`) apply as usual: menus need `enablePlayerControl`, buttons of
other screens (`mc.get_ui()`, `mc.click_widget({ widget })`) `enableUiControl`, and a chat line
starting with `/` sent by the player `enableCommands`.

Calls are allowed only inside tests, steps and hooks. A file's top level only registers things.

### The API

| | |
|---|---|
| `test(name, fn, { timeout })` | A test. `fn` gets `{ name, attempt, step, log }`. Names are unique per file. |
| `test.skip(name, fn)` / `test.only(name, fn)` | Skip one, or run only the `only` tests of the file. |
| `beforeEach(fn)` / `afterEach(fn)` | Run around every test. `afterEach` runs when the test failed or ran out of time too. |
| `beforeAll(fn)` / `afterAll(fn)` | Run once per file, before the first and after the last test. A failed `beforeAll` fails the file's tests; `afterAll` still runs. |
| `step(name, fn)` | Names part of a test. A failure reports the steps it happened in (`outer > inner`). Steps nest. |
| `expect(value, message)` | `toBe`, `toEqual` (deep), `toBeTruthy`, `toBeFalsy`, `toBeDefined`, `toBeUndefined`, `toBeNull`, `toContain`, `toMatch`, `toBeGreaterThan`, `toBeGreaterThanOrEqual`, `toBeLessThan`, `toBeLessThanOrEqual`, `toBeCloseTo`, `toHaveLength`, `toHaveProperty(path, value?)`, and `.not.` before any of them. |
| `expect.poll(fn, { timeout, interval })` | The same matchers, retried until they pass: `await expect.poll(() => inventoryCount("torch")).toBe(64)`. Returns the last value. |
| `assert(cond, message)`, `assert.equal(a, b)`, `assert.fail(message)` | Plain assertions. |
| `waitFor(fn, { timeout, interval, message })` | Calls `fn` until it returns something truthy and returns that. A throw counts as "not yet". |
| `waitForChat(textOrRegExp, { timeout, from })` | The next chat or system line containing the text (or matching the RegExp), as `{ text, type, sender }`. `from` limits it to one sender. |
| `waitForEvent(type or [types], { where, timeout })` | The next game event of that type for which `where(event)` is true (`player_damage`, `self_death`, `mining_finished`, `player_join`, ...). |
| `waitForScreen(kindOrTitle or fn, { timeout })` | Waits until `screen.get` shows that screen: a kind (`"none"`, `"container"`, `"death"`, ...), part of a screen title, or a predicate. |
| `command(text, { allowFail })` | Runs a server command; throws with the game's output when it fails, unless `allowFail` is set (`clear` on an empty inventory fails). Needs a server with the mod and `enableCommands`. |
| `goTo({ x, y, z }, { timeout, reach })` | Walks the player there with the bot's pathfinder and waits; throws when it ends any other way (stuck, no path, timeout). Default 60 s, within 1 block. |
| `inventoryCount(item)` | How many of an item (`"torch"` or `"minecraft:torch"`) the player holds, hotbar, main inventory and off hand together. |
| `mark()` | The id of the newest game event, to pass as `since` to the waits. |
| `sleep(ms)` | Waits. Prefer the waits above: they finish as soon as the game is ready. |
| `params` | Values from `--param key=value` on the command line. |

Waits default to 10 seconds and poll every 250 ms; `timeout` and `interval` change that. They throw
a `TimeoutError` that says what they waited for and the last value or error they saw.

**Events and chat count from the start of the test.** A line printed before the test began never
matches. Each match moves the starting point past the matched event, so two waits match two lines
in order. On an integrated server both the server and the client report a chat message; a line
right next to a matched one that the same pattern accepts counts as the same line, so
`waitForChat("hi")` twice needs two messages. Pass `{ since: await mark() }` to start counting at
a moment of your choice.

### How tests run

Every test runs in a fresh sandbox (the QuickJS sandbox of `run_script`): the file is evaluated
again, then its `beforeEach` hooks, the test and its `afterEach` hooks run. Variables are not shared
between tests or with `beforeAll`; keep shared setup in the world (commands) or in a helper
function the tests call. One game is driven at a time, so tests run one after another.

When a test fails, the runner stops movement, navigation and mining the test may have left on,
then the next test starts. A test that runs out of time keeps its pending calls going while its
`afterEach` hooks run, so cleanup should not depend on the test having stopped.

The sandbox has no file system, network or timers of its own. A test may make up to 50,000 calls.

## Failures, retries, reports

For each failed attempt the runner keeps, under `--artifacts` (default `mctest-results/`):

- `screenshot.png`: what the client showed right after the failure (needs `enableVision`);
- `context.json`: the error with its step, the test's `mc.log` lines, the player's state, the open
  screen and the game events since the test started.

Text in `context.json` comes from the game: chat, item and entity names can be written by other
players.

`--retries 2` runs a failed test up to two more times. A test that passes on a later attempt is
reported as passed and flaky. `--junit file.xml` writes a JUnit report (one suite per file;
flaky attempts as `flakyFailure`, kept screenshots as `[[ATTACHMENT|path]]` in `system-out`),
which CI systems and JUnit report actions read. `--json file.json` writes everything the runner
knows.

## Recording a test

Play the part you want to test and let the mod write it down:

```
npx mcpfabric-test record smelting.mctest.js --name "smelt raw iron"
```

Then play in the game; press Enter in the terminal when you are done. The mod watches the player
each tick and records where you walk (waypoints), which hotbar slot you pick, the blocks you break
and place (with their state, so stairs keep their facing), blocks you use (levers, doors), items
used on their own, entities you hit or use, the containers you open with what your inventory
gained or lost, and your own chat. The player is told in chat when recording starts and stops.
It needs `enablePlayerControl` and stops by itself after 500 steps, 30 minutes or on leaving the
world.

The file it writes is a draft, one test that replays the steps with `goTo`, `break_block`,
`place_block_at`, `container_open` and the other tools, and ends by checking the inventory items
whose count changed. Read it before you trust it:

- Give the player the starting items first (the draft lists them in a comment), for example in
  `beforeEach` with `command("give @p ...")`, and put the player back where the recording began.
- Clicks inside menus are not recorded; the draft says what the inventory gained or lost there,
  and you add `container_click` steps.
- Entities differ between runs, so hits and uses on entities are left as comments.
- Commands you type in chat are not recorded, and a recorded chat line that starts with `/` is
  left as a comment instead of being sent again.

An agent can record too: `start_recording` and `stop_recording` (see the README) return the same
steps and the draft, so the player can show the agent a task instead of describing it.

## Command line

```
mcpfabric-test [files or directories...] [options]
  --grep <text>        only tests whose "file > name" contains the text
  --list               list the tests without running them
  --retries <n>        run a failed test up to n more times (default 0)
  --timeout <ms>       time limit of a test (default 30000; test(name, fn, { timeout }) wins)
  --hook-timeout <ms>  time limit of each hook (default 30000)
  --world <id>         refuse to run unless the game is in this world
  --world-id           print the id of the world the game is in
  --param key=value    a value the tests read as params.key (repeatable)
  --junit <file>       write a JUnit XML report
  --json <file>        write a JSON report
  --artifacts <dir>    where failed tests leave a screenshot and context.json
  --no-artifacts       keep nothing for failed tests
  --no-screenshots     keep context.json but no screenshot
  --bail               stop after the first failed test

mcpfabric-test record <file.mctest.js> [--name <test name>]
```

Directories are searched for `*.mctest.js` (skipping `node_modules` and dot folders); without
paths the current directory is searched.

## Safety

Test files are programs with the same reach as `run_script`: whatever the mod's locks allow,
including server commands. Run only test files you trust, and run destructive ones in a test world
named with `--world`, which refuses to start when the game is anywhere else. Do not run tests while
an agent drives the same game: both would move the same player.

## Limits

- The runner drives a game that is already running. Starting a client in CI (a virtual display,
  a launcher, joining a world) is up to the pipeline for now.
- There is no snapshot and restore of the player or the world yet; reset what a test changes in
  `afterEach` (commands such as `clear`, `tp`, `gamemode`).
- `command()` needs a server with the mod: singleplayer, or a dedicated server running the mod. On
  a server without it (Paper, Spigot, another modded server), test through the client: chat,
  menus, the inventory, what the screen shows.
- Menu slots carry the item id and count, not the item's custom name or lore yet, so tell shop
  items apart by id or slot.
- Waits read the mod's event buffer (the last 2000 events); a wait that falls far behind a very
  busy server can miss events.
