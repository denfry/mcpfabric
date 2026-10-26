import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

// Runs against the compiled server: npm run build first (npm test does).
import { TOOLS } from "../dist/tools.js";

const serverEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const pos = { x: 10, y: 64, z: -5 };
const corner = { x: 14, y: 70, z: -1 };
const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";

/**
 * Every bridge tool by name: the RPC method it must call, arguments that validate, and (where the
 * schema can reject anything) arguments that must not. A new tool fails the first test until it is
 * added here.
 */
const BRIDGE_TOOLS = {
  // info
  get_status: { method: "info.status", args: {} },
  list_capabilities: { method: "info.capabilities", args: {} },
  // world (read)
  get_block: { method: "world.getBlock", args: { ...pos }, invalid: { x: 10, y: 64 } },
  get_blocks_region: { method: "world.getBlocks", args: { from: pos, to: corner, includeAir: true, includeState: true }, invalid: { from: pos, to: corner, maxBlocks: 0 } },
  find_blocks: { method: "world.findBlocks", args: { center: pos, radius: 16, blockIds: ["minecraft:diamond_ore"] }, invalid: { center: pos, radius: 16, blockIds: [] } },
  get_time_and_weather: { method: "world.getTimeAndWeather", args: { dimension: "minecraft:the_nether" }, invalid: { dimension: 7 } },
  list_dimensions: { method: "world.getDimensions", args: {} },
  raycast: { method: "world.raycast", args: { origin: pos, yaw: 90, pitch: 10 }, invalid: { origin: pos, maxDistance: 300 } },
  // world (write)
  set_block: { method: "world.setBlock", args: { ...pos, blockId: "minecraft:oak_stairs[facing=east]" }, invalid: { ...pos } },
  fill_blocks: { method: "world.fill", args: { from: pos, to: corner, blockId: "minecraft:glass" }, invalid: { from: pos, blockId: "minecraft:glass" } },
  set_time: { method: "world.setTime", args: { time: 6000 }, invalid: { time: 24001 } },
  set_weather: { method: "world.setWeather", args: { weather: "rain", durationSeconds: 120 }, invalid: { weather: "snow" } },
  // entities
  query_entities: { method: "entities.query", args: { radius: 16, types: ["minecraft:zombie"] }, invalid: { radius: 0 } },
  get_entity: { method: "entities.get", args: { uuid }, invalid: {} },
  summon_entity: { method: "entities.summon", args: { type: "minecraft:armor_stand", ...pos, nbt: "{NoGravity:1b}" }, invalid: { ...pos } },
  remove_entity: { method: "entities.remove", args: { uuid }, invalid: { uuid: 42 } },
  // players (admin)
  list_players: { method: "players.list", args: {} },
  get_player: { method: "players.get", args: { player: "Steve" }, invalid: {} },
  teleport_player: { method: "players.teleport", args: { player: "Steve", x: 100, y: 70, z: -20, yaw: 90 }, invalid: { player: "Steve", x: 100, z: -20 } },
  set_gamemode: { method: "players.setGameMode", args: { player: "Steve", mode: "creative" }, invalid: { player: "Steve", mode: "hardcore" } },
  give_item: { method: "players.give", args: { player: "Steve", itemId: "minecraft:diamond", count: 3 }, invalid: { player: "Steve", itemId: "minecraft:diamond", count: 0 } },
  apply_effect: { method: "players.applyEffect", args: { player: "Steve", effectId: "minecraft:speed" }, invalid: { player: "Steve", effectId: "minecraft:speed", amplifier: 256 } },
  message_player: { method: "players.message", args: { player: "@all", text: "hello" }, invalid: { player: "@all" } },
  kick_player: { method: "players.kick", args: { player: "Steve", reason: "test" }, invalid: { reason: "test" } },
  // command and chat
  run_command: { method: "command.run", args: { command: "time set day" }, invalid: {} },
  send_chat: { method: "chat.send", args: { message: "hi" }, invalid: { message: 1 } },
  get_recent_chat: { method: "chat.getRecent", args: { limit: 10 }, invalid: { limit: 501 } },
  // local player
  get_self: { method: "player.getState", args: {} },
  get_inventory: { method: "player.getInventory", args: {} },
  get_equipment: { method: "player.getEquipment", args: {} },
  get_status_effects: { method: "player.getStatusEffects", args: {} },
  // control
  set_movement: { method: "control.setInput", args: { forward: true, sprint: true }, invalid: { forward: "yes" } },
  stop_movement: { method: "control.stop", args: {} },
  look: { method: "control.look", args: { yaw: 90, pitch: -10 }, invalid: { yaw: "north" } },
  look_at: { method: "control.lookAt", args: { ...pos }, invalid: { x: 10, y: 64 } },
  jump: { method: "control.jumpOnce", args: {} },
  start_using_item: { method: "control.startUsing", args: {} },
  stop_using_item: { method: "control.stopUsing", args: {} },
  // interact
  break_block: { method: "interact.breakBlock", args: { ...pos, mode: "instant" }, invalid: { ...pos, mode: "fast" } },
  place_block: { method: "interact.placeBlock", args: { ...pos, face: "north" }, invalid: { ...pos, face: "sideways" } },
  use_item: { method: "interact.useItem", args: {} },
  attack_entity: { method: "interact.attackEntity", args: { uuid }, invalid: {} },
  use_entity: { method: "interact.useEntity", args: { uuid }, invalid: {} },
  drop_held_item: { method: "interact.dropItem", args: { wholeStack: true }, invalid: { wholeStack: "all" } },
  // inventory
  select_hotbar_slot: { method: "inventory.selectHotbar", args: { slot: 4 }, invalid: { slot: 9 } },
  drop_slot: { method: "inventory.dropSlot", args: { slot: 40 }, invalid: { slot: 41 } },
  swap_slots: { method: "inventory.swapSlots", args: { slotA: 0, slotB: 36 }, invalid: { slotA: 0, slotB: 46 } },
  // vision
  screenshot: { method: "vision.screenshot", args: {}, image: true },
  describe_scene: { method: "vision.describeScene", args: { rayColumns: 3, rayRows: 3 }, invalid: { rayColumns: 34 } },
  // navigation
  navigate_to: { method: "nav.pathTo", args: { ...pos, sprint: true }, invalid: { ...pos, reachRadius: 17 } },
  navigation_status: { method: "nav.status", args: {} },
  stop_navigation: { method: "nav.stop", args: {} },
  // session and menus
  get_screen: { method: "screen.get", args: {} },
  close_screen: { method: "screen.close", args: {} },
  list_worlds: { method: "session.worlds", args: {} },
  join_world: { method: "session.join", args: { worldId: "sp:New World" }, invalid: { worldId: 7 } },
  // ui
  get_ui: { method: "ui.widgets", args: {} },
  click_widget: { method: "ui.click", args: { widget: "Done", fraction: 0.5 }, invalid: { widget: -1 } },
  set_text_field: { method: "ui.setText", args: { widget: 3, text: "diamond" }, invalid: { widget: 3, text: "x".repeat(257) } },
  // events
  poll_events: { method: "events.getRecent", args: { types: ["chat"], sinceId: 10 }, invalid: { sinceId: -1 } },
  // supervised
  supervised_status: { method: "supervised.status", args: {} },
  supervised_stop: { method: "supervised.stop", args: {} },
  supervised_input: { method: "supervised.input", args: { direction: "forward" }, invalid: { direction: "forward", ticks: 11 } },
  supervised_read_block: { method: "supervised.readBlock", args: { ...pos }, invalid: { x: 10.5, y: 64, z: -5 } },
  supervised_set_block: { method: "supervised.setBlock", args: { ...pos, block: "minecraft:stone", expect: "minecraft:air" }, invalid: { ...pos, block: "minecraft:stone" } },
  supervised_command: { method: "supervised.command", args: { command: "time set day" }, invalid: { command: "x".repeat(257) } },
  supervised_enter_world: { method: "supervised.enterWorld", args: { worldId: "sp:Test World" }, invalid: {} },
  supervised_leave_world: { method: "supervised.leaveWorld", args: { worldId: "sp:Test World" }, invalid: { worldId: 1 } },
  supervised_reconcile: { method: "supervised.reconcile", args: { actionId: "a1" }, invalid: { actionId: "a1", acknowledge: "yes" } },
};

const toolNamed = (name) => {
  const tool = TOOLS.find((t) => t.name === name);
  assert.ok(tool, `no tool ${name} in TOOLS`);
  return tool;
};

test("the bridge tool table covers exactly the TOOLS catalogue", () => {
  assert.deepEqual(Object.keys(BRIDGE_TOOLS).sort(), TOOLS.map((t) => t.name).sort());
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, TOOLS.length, "tool names are unique");
});

test("every bridge tool maps to its method and validates its arguments", () => {
  for (const [name, entry] of Object.entries(BRIDGE_TOOLS)) {
    const tool = toolNamed(name);
    assert.equal(tool.method, entry.method, `${name} calls the wrong bridge method`);
    assert.equal(tool.kind === "image", !!entry.image, `${name} renders the wrong result kind`);
    const schema = z.object(tool.inputSchema);
    const ok = schema.safeParse(entry.args);
    assert.ok(ok.success, `${name} rejects valid arguments: ${ok.error?.message}`);
    if (entry.invalid) assert.equal(schema.safeParse(entry.invalid).success, false, `${name} accepts invalid arguments ${JSON.stringify(entry.invalid)}`);
  }
});

// ----- forwarding through the real server -------------------------------------------------------

const TOKEN = "test-token";
const PNG = "iVBORw0KGgo=";
const SESSION = "0123456789abcdef0123456789abcdef";
/** Calls the fake bridge received, in order. */
const received = [];
/** When set, the next bridge call fails with this error body. */
let failNext;
let bridge;
let client;

before(async () => {
  // A fake mod bridge on a loopback port: records each RPC and echoes it back.
  bridge = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const reply = (body) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (req.url !== "/rpc") return reply({});
    const { method, params } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push({ method, params, auth: req.headers.authorization });
    if (method === "supervised.begin") return reply({ ok: true, result: { session: SESSION } });
    if (failNext) {
      const error = failNext;
      failNext = undefined;
      return reply({ ok: false, error });
    }
    if (method === "vision.screenshot") return reply({ ok: true, result: { format: "png", base64: PNG, width: 2, height: 1 } });
    return reply({ ok: true, result: { echoed: method } });
  });
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const { port } = bridge.address();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, MCPFABRIC_URL: `http://127.0.0.1:${port}`, MCPFABRIC_TOKEN: TOKEN, MCPFABRIC_AGENT: "0" },
    stderr: "ignore",
  });
  client = new Client({ name: "bridge-tools-test", version: "0.0.0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  await new Promise((resolve) => bridge?.close(resolve));
});

test("the server registers every bridge tool with its schema and hints", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(BRIDGE_TOOLS).sort());
  for (const listed of tools) {
    const tool = toolNamed(listed.name);
    assert.equal(listed.title, tool.title, `${listed.name} title`);
    assert.deepEqual(listed.annotations, tool.annotations, `${listed.name} hints`);
    assert.deepEqual(Object.keys(listed.inputSchema.properties ?? {}).sort(), Object.keys(tool.inputSchema).sort(), `${listed.name} schema`);
  }
});

test("every bridge tool forwards its parsed arguments to its method", async () => {
  for (const [name, entry] of Object.entries(BRIDGE_TOOLS)) {
    received.length = 0;
    const result = await client.callTool({ name, arguments: entry.args });
    assert.equal(result.isError, undefined, `${name} failed: ${JSON.stringify(result.content)}`);
    // A supervised tool opens the supervisor session on its first call.
    const calls = received.filter((c) => c.method !== "supervised.begin");
    assert.equal(calls.length, 1, `${name} made ${calls.length} bridge calls`);
    const [call] = calls;
    assert.equal(call.method, entry.method, `${name} called the wrong method`);
    assert.equal(call.auth, `Bearer ${TOKEN}`, `${name} did not send the token`);
    // Defaults from the schema are applied before the call, as the MCP SDK parses the arguments.
    const parsed = z.object(toolNamed(name).inputSchema).parse(entry.args);
    if (toolNamed(name).supervised) {
      // The MCP server adds the session and a growing sequence number; the model passes neither.
      const { session, seq, ...rest } = call.params;
      assert.equal(session, SESSION, `${name} sent the wrong session`);
      assert.ok(Number.isInteger(seq) && seq > 0, `${name} sent no sequence number`);
      assert.deepEqual(rest, parsed, `${name} forwarded the wrong params`);
    } else {
      assert.deepEqual(call.params, parsed, `${name} forwarded the wrong params`);
    }
    if (entry.image) {
      assert.deepEqual(result.content, [
        { type: "image", data: PNG, mimeType: "image/png" },
        { type: "text", text: "Screenshot 2x1 (image/png)" },
      ]);
    } else {
      assert.deepEqual(result.structuredContent, { echoed: entry.method }, `${name} result`);
      assert.deepEqual(JSON.parse(result.content[0].text), { echoed: entry.method }, `${name} text result`);
    }
  }
});

test("invalid arguments are refused before they reach the bridge", async () => {
  for (const [name, entry] of Object.entries(BRIDGE_TOOLS)) {
    if (!entry.invalid) continue;
    received.length = 0;
    const result = await client.callTool({ name, arguments: entry.invalid });
    assert.equal(result.isError, true, `${name} accepted ${JSON.stringify(entry.invalid)}`);
    assert.match(result.content[0].text, /Input validation error/, name);
    assert.equal(received.length, 0, `${name} called the bridge with invalid arguments`);
  }
});

test("a bridge error comes back as a tool error with its code", async () => {
  failNext = { code: "capability_disabled", message: "World writes are disabled", data: { flag: "enableWorldWrites" } };
  const result = await client.callTool({ name: "set_block", arguments: BRIDGE_TOOLS.set_block.args });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'Bridge error [capability_disabled]: World writes are disabled\n{"flag":"enableWorldWrites"}');
});
