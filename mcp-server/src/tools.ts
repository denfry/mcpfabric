/**
 * The full mcpfabric tool catalogue.
 *
 * This table is the single source of truth for the RPC contract on the TypeScript side: every
 * entry maps an MCP tool (snake_case name) to a bridge RPC `method` (namespaced, dotted) plus a
 * zod input schema. `src/index.ts` registers each entry generically. Keep this in sync with the
 * Java handler registry in the mod (`dev.mcpfabric.handlers.*`).
 */
import { z } from "zod";

export interface ToolDef {
  /** MCP tool name exposed to the model. */
  name: string;
  /** Bridge RPC method this tool forwards to. */
  method: string;
  /** Short human title. */
  title: string;
  /** Description shown to the model — be precise about behaviour and side requirements. */
  description: string;
  /** zod raw shape describing the tool arguments. */
  inputSchema: z.ZodRawShape;
  /** Hints surfaced to MCP clients. */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** Rendering: "json" (default) returns text + structuredContent; "image" returns an image block. */
  kind?: "json" | "image";
}

// ----- reusable schema fragments -------------------------------------------------------------

const vec3 = () => ({
  x: z.number().describe("X coordinate (east/west)."),
  y: z.number().describe("Y coordinate (height)."),
  z: z.number().describe("Z coordinate (north/south)."),
});

const dimensionOpt = {
  dimension: z
    .string()
    .optional()
    .describe('Dimension id, e.g. "minecraft:overworld", "minecraft:the_nether". Defaults to the current/overworld dimension.'),
};

const playerRef = {
  player: z
    .string()
    .describe('Target player by name or UUID. Use "@all" where broadcasting is meaningful.'),
};

const faceEnum = z.enum(["up", "down", "north", "south", "east", "west"]);

const sneakOpt = {
  sneak: z
    .boolean()
    .optional()
    .default(false)
    .describe("Hold shift for this interaction only (sneak + right-click), released right after. Atomic: no separate set_movement call."),
};

const widgetRef = {
  index: z.number().int().min(0).optional().describe("Widget index as listed by get_screen."),
  label: z.string().optional().describe("Widget label (visible text). Matched exactly first, then case-insensitively as a substring."),
};

const READ = { readOnlyHint: true } as const;
const WRITE = { destructiveHint: true } as const;

// ----- catalogue ------------------------------------------------------------------------------

export const TOOLS: ToolDef[] = [
  // ===== info ================================================================================
  {
    name: "get_status",
    method: "info.status",
    title: "Server/client status",
    description:
      "Get the current state of the running game: mod & Minecraft version, which side this bridge runs on (client / dedicated_server), whether an integrated server is present, whether the player is in a world, current dimension, and the list of available capability groups. Call this first to learn what you can do right now.",
    inputSchema: {},
    annotations: READ,
  },
  {
    name: "list_capabilities",
    method: "info.capabilities",
    title: "List capabilities",
    description:
      "List every capability group and whether it is currently available on this side (e.g. control/interact/vision/nav are client-only; players/command admin need a server). Useful to decide which tools will work.",
    inputSchema: {},
    annotations: READ,
  },

  // ===== world (read) ========================================================================
  {
    name: "get_block",
    method: "world.getBlock",
    title: "Get block at position",
    description:
      "Read the block at an exact integer position: its block id, blockstate properties, whether it is air/fluid/solid, light levels, and hardness. Requires a loaded chunk.",
    inputSchema: { ...vec3(), ...dimensionOpt },
    annotations: READ,
  },
  {
    name: "get_blocks_region",
    method: "world.getBlocks",
    title: "Scan a cuboid region",
    description:
      "Scan all blocks in the cuboid between two corners (inclusive) and return their ids. Volume is capped (default 32768 blocks) to protect the server; air is omitted unless includeAir is true. Use for mapping a small area.",
    inputSchema: {
      from: z.object(vec3()).describe("One corner of the cuboid."),
      to: z.object(vec3()).describe("Opposite corner of the cuboid."),
      includeAir: z.boolean().optional().default(false).describe("Include air blocks in the result."),
      maxBlocks: z.number().int().min(1).max(200000).optional().describe("Override the per-call block cap."),
      ...dimensionOpt,
    },
    annotations: READ,
  },
  {
    name: "find_blocks",
    method: "world.findBlocks",
    title: "Find nearby blocks by id",
    description:
      "Search a spherical radius around a center point for blocks matching any of the given ids (e.g. minecraft:diamond_ore). Returns matches sorted by distance. Only searches loaded chunks.",
    inputSchema: {
      center: z.object(vec3()).describe("Center of the search sphere."),
      radius: z.number().int().min(1).max(128).describe("Search radius in blocks."),
      blockIds: z.array(z.string()).min(1).describe('Block ids to match, e.g. ["minecraft:diamond_ore","minecraft:ancient_debris"].'),
      maxResults: z.number().int().min(1).max(1024).optional().default(64).describe("Maximum matches to return."),
      ...dimensionOpt,
    },
    annotations: READ,
  },
  {
    name: "get_time_and_weather",
    method: "world.getTimeAndWeather",
    title: "Time & weather",
    description:
      "Get the current day-time (0-24000), total game-time, day count, and weather (raining/thundering) for a dimension.",
    inputSchema: { ...dimensionOpt },
    annotations: READ,
  },
  {
    name: "list_dimensions",
    method: "world.getDimensions",
    title: "List dimensions",
    description: "List all dimensions present on the server and which one the player is currently in.",
    inputSchema: {},
    annotations: READ,
  },
  {
    name: "raycast",
    method: "world.raycast",
    title: "Raycast from a point",
    description:
      "Cast a ray and report the first block and/or entity it hits. Origin defaults to the player's eyes and the direction to where the player looks, so a call with no arguments answers 'what is in front of me' (get_target gives the exact crosshair hit). Otherwise provide a direction vector or yaw/pitch angles.",
    inputSchema: {
      origin: z.object(vec3()).optional().describe("Ray start position. Defaults to the player's eye position."),
      player: z.string().optional().describe("Player (name or UUID) whose eyes/look are the defaults. Optional when exactly one player is online."),
      direction: z.object(vec3()).optional().describe("Ray direction vector (need not be normalized). Use this OR yaw/pitch; defaults to the player's look direction."),
      yaw: z.number().optional().describe("Yaw in degrees (Minecraft convention). Use with pitch instead of direction."),
      pitch: z.number().optional().describe("Pitch in degrees (-90 up .. 90 down)."),
      maxDistance: z.number().min(0.1).max(256).optional().default(32).describe("Maximum ray length in blocks."),
      includeFluids: z.boolean().optional().default(false).describe("Treat fluids as hittable."),
      includeEntities: z.boolean().optional().default(true).describe("Also test entities along the ray."),
      ...dimensionOpt,
    },
    annotations: READ,
  },

  {
    name: "get_block_inventory",
    method: "world.getBlockInventory",
    title: "Read a block's inventory",
    description:
      "List the slots of a block's item inventory through the loader's item-handler capability (NeoForge item handler / Fabric Transfer API), so it also works for modded devices that expose no vanilla container. side selects the face the handler is queried from (omit for the block's unsided view). Requires a server.",
    inputSchema: {
      ...vec3(),
      side: faceEnum.optional().describe("Face to query the item handler from; omit for the unsided handler."),
      ...dimensionOpt,
    },
    annotations: READ,
  },

  // ===== world (write) =======================================================================
  {
    name: "set_block",
    method: "world.setBlock",
    title: "Set a block",
    description:
      "Place/replace the block at an exact position with the given block id (optionally with blockstate properties as a string like 'minecraft:oak_log[axis=y]'). Requires a server (integrated client or dedicated).",
    inputSchema: { ...vec3(), blockId: z.string().describe('Block id, optionally with state, e.g. "minecraft:stone" or "minecraft:oak_stairs[facing=east]".'), ...dimensionOpt },
    annotations: WRITE,
  },
  {
    name: "fill_blocks",
    method: "world.fill",
    title: "Fill a region with a block",
    description:
      "Fill the cuboid between two corners with one block id. Volume is capped for safety. Requires a server.",
    inputSchema: {
      from: z.object(vec3()),
      to: z.object(vec3()),
      blockId: z.string().describe("Block id to fill with."),
      ...dimensionOpt,
    },
    annotations: WRITE,
  },
  {
    name: "insert_item",
    method: "world.insertItem",
    title: "Insert items into a block",
    description:
      "Insert items into a block's inventory through the loader's item-handler capability, the way a hopper would (works for modded devices such as TerraFirmaCraft pots and barrels, where /item replace block fails). Returns how many were inserted. Requires a server.",
    inputSchema: {
      ...vec3(),
      item: z.string().describe('Item id, e.g. "minecraft:coal".'),
      count: z.number().int().min(1).max(6400).optional().default(1).describe("How many items to insert."),
      side: faceEnum.optional().describe("Face to insert from (e.g. up for a furnace's input); omit for the unsided handler."),
      simulate: z.boolean().optional().default(false).describe("Only report how many would fit; change nothing."),
      ...dimensionOpt,
    },
    annotations: WRITE,
  },
  {
    name: "set_time",
    method: "world.setTime",
    title: "Set time of day",
    description: "Set the day-time (0-24000; 0=dawn, 6000=noon, 12000=dusk, 18000=midnight). Requires a server.",
    inputSchema: { time: z.number().int().min(0).max(24000).describe("Day-time in ticks (0-24000).") },
    annotations: WRITE,
  },
  {
    name: "set_weather",
    method: "world.setWeather",
    title: "Set weather",
    description: "Set the weather. Requires a server.",
    inputSchema: {
      weather: z.enum(["clear", "rain", "thunder"]).describe("Target weather."),
      durationSeconds: z.number().int().min(1).optional().describe("How long the weather should last."),
    },
    annotations: WRITE,
  },

  // ===== entities ============================================================================
  {
    name: "query_entities",
    method: "entities.query",
    title: "Query entities",
    description:
      "List entities, optionally filtered by a sphere (center+radius), entity type ids, living-only, and whether to include players. Returns position, type, name, health and key flags for each.",
    inputSchema: {
      center: z.object(vec3()).optional().describe("Center of the search sphere; omit to use the player's position."),
      radius: z.number().min(1).max(256).optional().default(32).describe("Search radius in blocks."),
      types: z.array(z.string()).optional().describe('Entity type ids to match, e.g. ["minecraft:zombie","minecraft:cow"].'),
      includePlayers: z.boolean().optional().default(true),
      onlyLiving: z.boolean().optional().default(false),
      maxResults: z.number().int().min(1).max(1000).optional().default(100),
      ...dimensionOpt,
    },
    annotations: READ,
  },
  {
    name: "get_entity",
    method: "entities.get",
    title: "Get entity details",
    description: "Get detailed info about a single entity by UUID: type, position, velocity, health, equipment, NBT-derived attributes.",
    inputSchema: { uuid: z.string().describe("Entity UUID.") },
    annotations: READ,
  },
  {
    name: "summon_entity",
    method: "entities.summon",
    title: "Summon entity",
    description: "Summon an entity of the given type at a position, optionally with SNBT data. Requires a server.",
    inputSchema: {
      type: z.string().describe('Entity type id, e.g. "minecraft:armor_stand".'),
      ...vec3(),
      nbt: z.string().optional().describe("Optional SNBT, e.g. '{NoGravity:1b}'."),
      ...dimensionOpt,
    },
    annotations: WRITE,
  },
  {
    name: "remove_entity",
    method: "entities.remove",
    title: "Remove entity",
    description: "Discard (remove) a non-player entity by UUID. Requires a server.",
    inputSchema: { uuid: z.string().describe("Entity UUID to remove.") },
    annotations: WRITE,
  },

  // ===== players (admin, server-side) ========================================================
  {
    name: "list_players",
    method: "players.list",
    title: "List online players",
    description: "List all online players with name, UUID, position, dimension, health, food, game mode and ping. Requires a server.",
    inputSchema: {},
    annotations: READ,
  },
  {
    name: "get_player",
    method: "players.get",
    title: "Get player details",
    description: "Get detailed state for one online player. Requires a server.",
    inputSchema: { ...playerRef },
    annotations: READ,
  },
  {
    name: "teleport_player",
    method: "players.teleport",
    title: "Teleport player",
    description: "Teleport a player to coordinates (and optionally another dimension / facing). Requires a server.",
    inputSchema: { ...playerRef, ...vec3(), yaw: z.number().optional(), pitch: z.number().optional(), ...dimensionOpt },
    annotations: WRITE,
  },
  {
    name: "set_gamemode",
    method: "players.setGameMode",
    title: "Set player game mode",
    description: "Set a player's game mode. Requires a server.",
    inputSchema: { ...playerRef, mode: z.enum(["survival", "creative", "adventure", "spectator"]) },
    annotations: WRITE,
  },
  {
    name: "give_item",
    method: "players.give",
    title: "Give item to player",
    description: "Give an item stack to a player. Requires a server.",
    inputSchema: {
      ...playerRef,
      itemId: z.string().describe('Item id, e.g. "minecraft:diamond".'),
      count: z.number().int().min(1).max(6400).optional().default(1),
      nbt: z.string().optional().describe("Optional SNBT components."),
    },
    annotations: WRITE,
  },
  {
    name: "apply_effect",
    method: "players.applyEffect",
    title: "Apply status effect",
    description: "Apply a potion/status effect to a player. Requires a server.",
    inputSchema: {
      ...playerRef,
      effectId: z.string().describe('Effect id, e.g. "minecraft:speed".'),
      durationSeconds: z.number().int().min(1).optional().default(30),
      amplifier: z.number().int().min(0).max(255).optional().default(0),
      showParticles: z.boolean().optional().default(true),
    },
    annotations: WRITE,
  },
  {
    name: "message_player",
    method: "players.message",
    title: "Send system message",
    description: 'Send a system/chat message to a player ("@all" to broadcast). Requires a server.',
    inputSchema: { ...playerRef, text: z.string() },
  },
  {
    name: "kick_player",
    method: "players.kick",
    title: "Kick player",
    description: "Kick a player from the server. Requires a dedicated server.",
    inputSchema: { ...playerRef, reason: z.string().optional() },
    annotations: WRITE,
  },

  // ===== command =============================================================================
  {
    name: "run_command",
    method: "command.run",
    title: "Run a server command",
    description:
      "Execute an arbitrary Minecraft command at operator permission level 4 (do NOT include the leading slash) and capture its feedback output. This is extremely powerful (/setblock, /summon, /give, /tp, /gamerule, /execute, datapacks, ...). Requires a server.",
    inputSchema: { command: z.string().describe('Command without the leading slash, e.g. "time set day".') },
    annotations: { destructiveHint: true, openWorldHint: true },
  },

  // ===== chat ================================================================================
  {
    name: "send_chat",
    method: "chat.send",
    title: "Send chat message",
    description:
      "Send a chat message. On a client this is sent as the local player (a leading '/' runs a command as that player); on a dedicated server it is broadcast.",
    inputSchema: { message: z.string() },
  },
  {
    name: "get_recent_chat",
    method: "chat.getRecent",
    title: "Get recent chat",
    description: "Return recently observed chat & system messages (most recent last).",
    inputSchema: { limit: z.number().int().min(1).max(500).optional().default(50) },
    annotations: READ,
  },

  // ===== player (client local player) ========================================================
  {
    name: "get_self",
    method: "player.getState",
    title: "Get local player state",
    description:
      "Client-only. Full state of YOUR player: position, yaw/pitch, motion, health, food, saturation, air, XP, game mode, on-ground, in-fluid, selected hotbar slot, dimension.",
    inputSchema: {},
    annotations: READ,
  },
  {
    name: "get_inventory",
    method: "player.getInventory",
    title: "Get inventory",
    description: "Client-only. Full inventory: main slots, hotbar, armor, offhand, and the selected slot. Each item reports id, count and durability.",
    inputSchema: {},
    annotations: READ,
  },
  {
    name: "get_equipment",
    method: "player.getEquipment",
    title: "Get equipment",
    description: "Client-only. Currently equipped items: main hand, off hand, helmet, chestplate, leggings, boots.",
    inputSchema: {},
    annotations: READ,
  },
  {
    name: "get_tooltip",
    method: "player.getTooltip",
    title: "Get item tooltip",
    description:
      "Client-only. The tooltip of an item as plain text lines, including the lines mods add (quality, composition, decay dates, ...). Address the item by player inventory slot, or by menu slot of the open container screen (as listed by get_screen).",
    inputSchema: {
      slot: z.number().int().min(0).max(40).optional().describe("Player inventory slot (0-8 hotbar, 9-35 main, 36-39 armor, 40 offhand). Defaults to the selected hotbar slot."),
      menuSlot: z.number().int().min(0).optional().describe("Slot index in the open container screen, instead of a player inventory slot."),
      advanced: z.boolean().optional().default(false).describe("Advanced tooltips (as with F3+H): item id, durability, component count."),
    },
    annotations: READ,
  },
  {
    name: "get_target",
    method: "player.getTarget",
    title: "What the crosshair hits",
    description:
      "Client-only. What the crosshair is on right now: a block (position, face, id, state properties, hit point) or an entity (uuid, type, name, position), or nothing within reach.",
    inputSchema: {},
    annotations: READ,
  },
  {
    name: "get_status_effects",
    method: "player.getStatusEffects",
    title: "Get active effects",
    description: "Client-only. Active status effects on your player with amplifier and remaining duration.",
    inputSchema: {},
    annotations: READ,
  },

  // ===== control (client) ====================================================================
  {
    name: "set_movement",
    method: "control.setInput",
    title: "Set movement input",
    description:
      "Client-only. Set held movement inputs as booleans; they persist until changed (like holding keys). Any omitted field is left unchanged. Combine with look/look_at to walk somewhere. Use stop_movement to release everything.",
    inputSchema: {
      forward: z.boolean().optional(),
      back: z.boolean().optional(),
      left: z.boolean().optional(),
      right: z.boolean().optional(),
      jump: z.boolean().optional(),
      sneak: z.boolean().optional(),
      sprint: z.boolean().optional(),
    },
  },
  {
    name: "stop_movement",
    method: "control.stop",
    title: "Release all movement",
    description: "Client-only. Release all movement inputs (stop walking/jumping/sneaking/sprinting).",
    inputSchema: {},
  },
  {
    name: "look",
    method: "control.look",
    title: "Set/adjust look angles",
    description:
      "Client-only. Set absolute yaw/pitch, or apply relative deltas. Yaw: 0=south,-90=east,90=west,180=north. Pitch: -90=up, 90=down.",
    inputSchema: {
      yaw: z.number().optional().describe("Absolute yaw in degrees."),
      pitch: z.number().optional().describe("Absolute pitch in degrees (-90..90)."),
      deltaYaw: z.number().optional().describe("Relative yaw change in degrees."),
      deltaPitch: z.number().optional().describe("Relative pitch change in degrees."),
    },
  },
  {
    name: "look_at",
    method: "control.lookAt",
    title: "Look at a point",
    description: "Client-only. Rotate the player to face a world coordinate.",
    inputSchema: { ...vec3() },
  },
  {
    name: "jump",
    method: "control.jumpOnce",
    title: "Jump once",
    description: "Client-only. Perform a single jump.",
    inputSchema: {},
  },
  {
    name: "start_using_item",
    method: "control.startUsing",
    title: "Start using held item",
    description: "Client-only. Begin using/holding the right-click action of the held item (eat, draw bow, block with shield, etc.).",
    inputSchema: {},
  },
  {
    name: "stop_using_item",
    method: "control.stopUsing",
    title: "Stop using held item",
    description: "Client-only. Release the right-click use action.",
    inputSchema: {},
  },

  // ===== interact (client) ===================================================================
  {
    name: "break_block",
    method: "interact.breakBlock",
    title: "Break a block",
    description:
      "Client-only. Break the block at a position. mode 'instant' uses creative-style instant break; 'survival' performs realistic timed mining (must be reachable, ~within 5 blocks).",
    inputSchema: { ...vec3(), mode: z.enum(["instant", "survival"]).optional().default("survival") },
    annotations: WRITE,
  },
  {
    name: "place_block",
    method: "interact.placeBlock",
    title: "Place held block",
    description:
      "Client-only. Right-click the given block face with the held item (must be reachable): places a held block, or uses the block / item on it (open a GUI, fill a bucket, ...). Equip the desired item first with select_hotbar_slot. sneak: true makes it a shift-right-click in one call.",
    inputSchema: { ...vec3(), face: faceEnum.optional().default("up"), ...sneakOpt },
    annotations: WRITE,
  },
  {
    name: "use_item",
    method: "interact.useItem",
    title: "Use item / right-click",
    description: "Client-only. Right-click with the held item in the air (throw, start eating or drinking, ...). sneak: true makes it a shift-right-click.",
    inputSchema: { ...sneakOpt },
  },
  {
    name: "hold_use",
    method: "interact.holdUse",
    title: "Hold right-click on a block",
    description:
      "Client-only. Aim at a block face and hold right-click on it for a number of ticks, exactly like a player holding the button (repeated uses, charging, stirring, ...). Blocks until done (at most 200 ticks = 10 s) and reports what changed: the target block, the held item, food and saturation. No screen may be open.",
    inputSchema: {
      ...vec3(),
      face: faceEnum.optional().default("up").describe("Block face to aim at."),
      ticks: z.number().int().min(1).max(200).describe("How long to hold, in ticks (20 per second)."),
      ...sneakOpt,
    },
    annotations: WRITE,
  },
  {
    name: "consume_held",
    method: "interact.consumeHeld",
    title: "Eat / drink the held item",
    description:
      "Client-only. Use the held item until it is consumed (eat, drink, ...) or the timeout passes, then release. Reports whether it completed and what changed: food, saturation and the item left in hand.",
    inputSchema: {
      timeoutTicks: z.number().int().min(1).max(240).optional().default(100).describe("Give up after this many ticks (20 per second)."),
    },
  },
  {
    name: "attack_entity",
    method: "interact.attackEntity",
    title: "Attack entity",
    description: "Client-only. Attack (left-click) an entity by UUID. Must be in reach.",
    inputSchema: { uuid: z.string() },
    annotations: WRITE,
  },
  {
    name: "use_entity",
    method: "interact.useEntity",
    title: "Interact with entity",
    description: "Client-only. Right-click/interact with an entity by UUID (e.g. trade with a villager, mount a horse).",
    inputSchema: { uuid: z.string() },
  },
  {
    name: "drop_held_item",
    method: "interact.dropItem",
    title: "Drop held item",
    description: "Client-only. Drop the held item (one, or the whole stack).",
    inputSchema: { wholeStack: z.boolean().optional().default(false) },
  },

  // ===== inventory (client) ==================================================================
  {
    name: "select_hotbar_slot",
    method: "inventory.selectHotbar",
    title: "Select hotbar slot",
    description: "Client-only. Select a hotbar slot (0-8) as the held item.",
    inputSchema: { slot: z.number().int().min(0).max(8) },
  },
  {
    name: "drop_slot",
    method: "inventory.dropSlot",
    title: "Drop a specific slot",
    description: "Client-only. Drop the contents of a specific inventory slot.",
    inputSchema: { slot: z.number().int().min(0).max(40).describe("Inventory slot index (0-8 hotbar, 9-35 main, 36-39 armor, 40 offhand)."), wholeStack: z.boolean().optional().default(true) },
  },
  {
    name: "swap_slots",
    method: "inventory.swapSlots",
    title: "Swap two inventory slots",
    description: "Client-only. Swap the items in two inventory slots via container clicks (player inventory must be the active screen-less context).",
    inputSchema: { slotA: z.number().int().min(0).max(45), slotB: z.number().int().min(0).max(45) },
  },

  // ===== ui / input (client) =================================================================
  {
    name: "get_screen",
    method: "ui.getScreen",
    title: "Read the open screen",
    description:
      "Client-only. Describe the open screen (menu, GUI, container): class name, title, every widget (index, type, label, x/y/width/height in GUI pixels, active, visible, focused, text-field value) and, for container screens, every menu slot (index, item id, count, name, x/y relative to the container's top-left) plus the stack on the cursor. screen is null in-game with no screen open.",
    inputSchema: {},
    annotations: READ,
  },
  {
    name: "close_screen",
    method: "ui.closeScreen",
    title: "Close the open screen",
    description:
      "Client-only. Close the open screen the way Esc does (a container is also closed on the server). Some screens ignore Esc (e.g. a mandatory name prompt); force: true closes them anyway.",
    inputSchema: { force: z.boolean().optional().default(false).describe("Close even a screen that ignores Esc.") },
  },
  {
    name: "click_widget",
    method: "ui.clickWidget",
    title: "Click a screen widget",
    description:
      "Client-only. Click a button, checkbox, tab or text field of the open screen by index or label (see get_screen): a real mouse click at the widget's centre.",
    inputSchema: {
      ...widgetRef,
      button: z.number().int().min(0).max(2).optional().default(0).describe("Mouse button: 0 left, 1 right, 2 middle."),
    },
  },
  {
    name: "click_at",
    method: "ui.clickAt",
    title: "Click a point of the screen",
    description:
      "Client-only. Click at a point in the open screen's own GUI-scaled coordinates (width/height from get_screen). For screens that draw their own tabs and rows instead of widgets, where click_widget finds nothing.",
    inputSchema: {
      x: z.number().describe("X in GUI-scaled screen coordinates."),
      y: z.number().describe("Y in GUI-scaled screen coordinates."),
      button: z.number().int().min(0).max(2).optional().default(0).describe("Mouse button: 0 left, 1 right, 2 middle."),
    },
  },
  {
    name: "click_slot",
    method: "ui.clickSlot",
    title: "Click a container slot",
    description:
      "Client-only. Click a slot of the open container screen (slot index from get_screen) as the player would: pick up, put down or split a stack, or shift-click to move it to the other inventory. Returns the slot and cursor contents afterwards.",
    inputSchema: {
      slot: z.number().int().min(-999).describe("Menu slot index; -999 clicks outside the window (drops the cursor stack)."),
      button: z.number().int().min(0).max(1).optional().default(0).describe("0 left (whole stack), 1 right (half / one)."),
      shift: z.boolean().optional().default(false).describe("Shift-click (quick-move)."),
    },
  },
  {
    name: "type_text",
    method: "ui.typeText",
    title: "Type text",
    description:
      "Client-only. Type text into the focused text field of the open screen, character by character (focus one first with focus_widget or click_widget). enter: true presses Enter afterwards.",
    inputSchema: {
      text: z.string().describe("Text to type (any Unicode)."),
      enter: z.boolean().optional().default(false).describe("Press Enter after typing."),
    },
  },
  {
    name: "focus_widget",
    method: "ui.focus",
    title: "Focus a widget",
    description: "Client-only. Give keyboard focus to a widget of the open screen (usually a text field) by index or label.",
    inputSchema: { ...widgetRef },
  },
  {
    name: "press_key",
    method: "input.pressKey",
    title: "Press a key",
    description:
      'Client-only. Press a keyboard key as the player would: in-game (e opens the inventory, f1 hides the HUD, f3 toggles the debug screen, 1-9 select hotbar slots) and on any open screen (escape closes it; enter / tab in text fields). Key names follow GLFW: "escape", "enter", "tab", "backspace", "space", "e", "f3", "1", "up", "left.shift", ... A key-binding name such as "key.inventory" presses whatever key it is bound to.',
    inputSchema: {
      key: z.string().describe('Key name, e.g. "escape", "e", "f1", "1", "enter", or a key binding like "key.inventory".'),
      holdTicks: z.number().int().min(0).max(1200).optional().default(0).describe("Keep the key down this many ticks before releasing (0 = tap). Returns at once; the release is scheduled."),
      modifiers: z.array(z.enum(["shift", "ctrl", "alt"])).optional().describe("Modifier keys held with it."),
    },
  },

  // ===== singleplayer worlds (client) ========================================================
  {
    name: "list_saves",
    method: "world.listSaves",
    title: "List singleplayer worlds",
    description: "Client-only. List the singleplayer saves: folder id, display name, last played time, game mode, cheats, and whether it is locked (open elsewhere).",
    inputSchema: {},
    annotations: READ,
  },
  {
    name: "join_world",
    method: "world.joinSingleplayer",
    title: "Open a singleplayer world",
    description:
      "Client-only. Load a singleplayer world by folder id or display name (see list_saves). Leave the current world first. Returns once loading has started; poll get_status until the player is in the world, and get_screen in case a confirmation prompt needs a click.",
    inputSchema: { name: z.string().describe("World folder id or display name.") },
  },
  {
    name: "create_world",
    method: "world.create",
    title: "Create a singleplayer world",
    description:
      'Client-only. Create and enter a new singleplayer world. levelType is any world-preset id from the registry, modded ones included ("minecraft:normal", "minecraft:flat", "minecraft:large_biomes", "tfc:overworld", ...). Leave the current world first. Returns once creation has started; poll get_status until in the world, and get_screen in case a warning (e.g. experimental features) needs a click.',
    inputSchema: {
      name: z.string().describe("World name."),
      seed: z.string().optional().describe("Seed (number or text); random when omitted."),
      gameMode: z.enum(["survival", "creative", "hardcore"]).optional().describe("Game mode; the screen's default when omitted."),
      cheats: z.boolean().optional().describe("Allow commands (cheats)."),
      levelType: z.string().optional().describe('World preset id, e.g. "minecraft:flat" or "tfc:overworld".'),
    },
  },
  {
    name: "leave_world",
    method: "world.leave",
    title: "Leave the world",
    description:
      "Client-only. Save and quit to the title screen (singleplayer) or disconnect (multiplayer), like the pause menu button. Returns once scheduled; poll get_screen for the title screen.",
    inputSchema: {},
  },

  // ===== client window & options =============================================================
  {
    name: "set_window",
    method: "client.setWindow",
    title: "Resize the game window",
    description: "Client-only. Resize the game window (leaving fullscreen first). For layout checks at several sizes.",
    inputSchema: {
      width: z.number().int().min(320).max(7680).describe("Window width in pixels."),
      height: z.number().int().min(240).max(4320).describe("Window height in pixels."),
    },
  },
  {
    name: "set_gui_scale",
    method: "client.setGuiScale",
    title: "Set GUI scale",
    description: "Client-only. Set the GUI scale (0 = auto; a value larger than the window allows falls back to the largest that fits). Reports the effective scale and the scaled screen size.",
    inputSchema: { scale: z.number().int().min(0).max(10) },
  },
  {
    name: "set_language",
    method: "client.setLanguage",
    title: "Set language",
    description: 'Client-only. Switch the game language (e.g. "en_us", "ru_ru") and reload resources. Returns once the reload has started; it takes a few seconds.',
    inputSchema: { code: z.string().describe('Language code, e.g. "en_us".') },
  },
  {
    name: "set_hud_hidden",
    method: "client.setHudHidden",
    title: "Hide / show the HUD",
    description: "Client-only. Hide the HUD (like F1) for clean screenshots, or show it again.",
    inputSchema: { hidden: z.boolean() },
  },
  {
    name: "set_pause_on_lost_focus",
    method: "client.setPauseOnLostFocus",
    title: "Pause on focus loss",
    description:
      "Client-only. Whether the game opens the pause menu when its window loses focus. The bridge already turns this off for the session on its first call (config keepRunningUnfocused), so screenshots of a background window show the game, not the pause menu.",
    inputSchema: { enabled: z.boolean() },
  },

  // ===== vision (client) =====================================================================
  {
    name: "screenshot",
    method: "vision.screenshot",
    title: "Capture screenshot",
    description:
      "Client-only. Capture the current game framebuffer as a PNG image (at the game's current resolution) so a vision-capable model can literally see what the player sees.",
    inputSchema: {},
    annotations: READ,
    kind: "image",
  },
  {
    name: "describe_scene",
    method: "vision.describeScene",
    title: "Describe visible scene",
    description:
      "Client-only. Produce a structured, text description of what is visible: the block/entity directly under the crosshair, a grid of raycasts across the field of view, and nearby visible entities. A cheap alternative to a screenshot for non-vision models.",
    inputSchema: {
      maxDistance: z.number().min(1).max(128).optional().default(48),
      rayColumns: z.number().int().min(1).max(33).optional().default(9),
      rayRows: z.number().int().min(1).max(33).optional().default(5),
    },
    annotations: READ,
  },

  // ===== navigation (client, A*) =============================================================
  {
    name: "navigate_to",
    method: "nav.pathTo",
    title: "Navigate to a position",
    description:
      "Client-only. Asynchronously walk the player to a target position using A* pathfinding (handles walking, jumping up 1 block, and dropping down). Returns immediately; poll navigation_status to track progress and stop_navigation to cancel.",
    inputSchema: {
      ...vec3(),
      reachRadius: z.number().min(0).max(16).optional().default(1).describe("Stop when within this many blocks of the target."),
      sprint: z.boolean().optional().default(false),
      timeoutSeconds: z.number().int().min(1).max(600).optional().default(60),
    },
  },
  {
    name: "navigation_status",
    method: "nav.status",
    title: "Navigation status",
    description: "Client-only. Report whether navigation is active, the target, remaining distance/steps, and whether the bot appears stuck.",
    inputSchema: {},
    annotations: READ,
  },
  {
    name: "stop_navigation",
    method: "nav.stop",
    title: "Stop navigation",
    description: "Client-only. Cancel any active navigation and release movement.",
    inputSchema: {},
  },

  // ===== events ==============================================================================
  {
    name: "poll_events",
    method: "events.getRecent",
    title: "Poll recent game events",
    description:
      "Return recently observed game events from the in-mod ring buffer (damage taken, entity spawn/death, block break/place, chat, dimension change, etc.). Filter by type and/or pass sinceId to get only events newer than one you've already seen.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional().default(50),
      types: z.array(z.string()).optional().describe('Event type filter, e.g. ["chat","player_damage","entity_death"].'),
      sinceId: z.number().int().min(0).optional().describe("Only return events with id greater than this."),
    },
    annotations: READ,
  },
];
