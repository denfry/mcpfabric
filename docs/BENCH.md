# Benchmark

`mcpfabric-bench` sets up small, checkable tasks in a test world, lets any agent play them through
mcpfabric, and scores the result from the game's state. It measures the whole stack (model, MCP
client, the tools and the agent runtime) and doubles as a regression test for the runtime.

| Task | Goal | Limit |
|---|---|---|
| `logs` | collect 8 logs from two trees placed nearby | 10 min |
| `crafting_table` | craft a crafting table from 2 logs | 5 min |
| `stone_pickaxe` | make a stone pickaxe from 3 logs and a stone pile | 15 min |
| `goto_beacon` | walk to a gold block on a glowstone pillar 12–24 blocks away | 5 min |
| `chest_loot` | find a chest 12–24 blocks away and take its diamond | ~7 min |
| `smelt_iron` | smelt an iron ingot with a furnace, coal and raw iron | 10 min |
| `climb` | get on top of a 4-high stone platform with some dirt | 5 min |

Each setup starts from survival, full health, day, clear weather and an **empty inventory**, and
places blocks around the player. Use a disposable world: a superflat creative-cheats world works.
Setups run server commands, so the game needs an integrated server and `enableCommands`.

```bash
cd mcp-server && npm run build
node dist/bench/cli.js world                                  # the id of the world you are in
node dist/bench/cli.js list
# one task by hand: set up, play it with any client, then score it
node dist/bench/cli.js setup logs --world sp:BenchWorld
node dist/bench/cli.js check logs
# a whole run with an agent command; {prompt} becomes the quoted task prompt
node dist/bench/cli.js run all --world sp:BenchWorld --seed 1 --out results.jsonl \
  --agent 'claude -p {prompt} --allowedTools mcp__mcpfabric'
```

`--world` must match the world the game is in, or nothing is set up. Offsets come from `--seed`,
so a run can be repeated. `--out` appends one JSON line per task (pass, detail, seconds, whether the
time limit stopped the agent). The agent command also gets the prompt in `MCPFABRIC_BENCH_PROMPT`.
The bench finds the game like the MCP server does (`MCPFABRIC_TOKEN` or `~/.mcpfabric/bridge.json`).
