package dev.mcpfabric.client.handlers;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.client.AiControl;
import dev.mcpfabric.client.BotController;
import dev.mcpfabric.client.ClientMc;
import dev.mcpfabric.handlers.support.Gates;
import dev.mcpfabric.handlers.support.Levels;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.inventory.CreativeModeInventoryScreen;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Records what the player does by hand ({@code recorder.*}) as steps a test or an agent can replay:
 * walking (waypoints), hotbar choice, breaking and placing blocks, using blocks, items and
 * entities, opening containers (with what the inventory gained or lost) and the player's own chat.
 *
 * <p>It only watches the client each tick (keys held, the block under the crosshair, the block
 * states that follow), so it needs no loader hook and works on any server. It cannot see commands
 * the player types or single clicks inside a menu. The player is told in chat when it starts and
 * stops; it stops by itself after {@link #MAX_STEPS} steps, {@link #MAX_MS} or on leaving the world.
 */
public final class RecorderHandlers {
	static final int MAX_STEPS = 500;
	static final long MAX_MS = 30L * 60 * 1000;
	private static final double WAYPOINT_DISTANCE = 4.0;
	/** Before an action, a waypoint is added when the player has moved at least this far. */
	private static final double ACTION_WAYPOINT_DISTANCE = 1.5;
	/** Ticks a mined or used block is watched for its effect. */
	private static final int PENDING_TICKS = 6;
	/** Holding the use key repeats every 4 ticks in vanilla. */
	private static final int USE_REPEAT_TICKS = 4;
	private static final int MAIN_SLOTS = 36;
	private static final int OFFHAND_SLOT = 40;

	private static boolean recording;
	private static boolean finishing;
	private static long startedAt;
	private static String stopReason;
	private static final List<JsonObject> steps = new ArrayList<>();
	private static Vec3 waypoint;
	private static int slot;
	private static String screen;
	private static boolean attackWas;
	private static boolean useWas;
	private static int useHeld;

	private static BlockPos mining;
	private static String miningId;
	private static int miningAge;

	private static BlockPos usedOn;
	private static BlockPos placeCell;
	private static BlockState usedBefore;
	private static BlockState cellBefore;
	private static String usedItem;
	private static int useAge;

	private static BlockPos lastUsed;
	private static Map<String, Integer> containerBefore;

	private RecorderHandlers() {}

	public static void register(RpcRouter router) {
		router.register("recorder.start", ctx -> ClientMc.call(() -> {
			Gates.recording();
			LocalPlayer p = ClientMc.player();
			if (recording) throw RpcException.badRequest("Already recording; stop it first (recorder.stop).");
			reset();
			recording = true;
			startedAt = System.currentTimeMillis();
			waypoint = p.position();
			slot = BotController.selectedSlot(p);
			screen = screenKind(ContainerHandlers.currentScreen());
			JsonObject start = at(BlockPos.containing(p.position()));
			start.addProperty("dimension", Levels.dimensionId(p.level()));
			start.addProperty("slot", slot);
			start.addProperty("held", itemId(p.getMainHandItem()));
			start.add("inventory", json(counts(p)));
			add("start", start);
			AiControl.chat(Component.literal("Recording your actions for a test. Up to " + MAX_STEPS + " steps or "
					+ MAX_MS / 60_000 + " minutes; the AI stops it when you are done."));
			return status();
		}));

		router.register("recorder.stop", ctx -> ClientMc.call(() -> {
			Gates.recording();
			if (!recording && steps.isEmpty()) throw RpcException.badRequest("Nothing was recorded; start with recorder.start.");
			if (recording) {
				LocalPlayer p = Minecraft.getInstance().player;
				if (p != null) flushWaypoint(p, 0.5);
				finish("stopped");
			}
			JsonObject o = status();
			JsonArray a = new JsonArray();
			for (JsonObject s : steps) a.add(s);
			o.add("steps", a);
			steps.clear();
			return o;
		}));

		router.register("recorder.status", ctx -> ClientMc.call(() -> {
			Gates.recording();
			return status();
		}));
	}

	/** The player's own chat message (called on the client thread). Vanilla's "<name> " is taken off. */
	public static void onOwnChat(String text, String name) {
		if (!recording || text == null) return;
		String prefix = "<" + name + "> ";
		JsonObject d = new JsonObject();
		d.addProperty("message", text.startsWith(prefix) ? text.substring(prefix.length()) : text);
		add("chat", d);
	}

	/** End of a client tick. */
	public static void onClientTick(Minecraft mc) {
		if (!recording) return;
		LocalPlayer p = mc.player;
		ClientLevel level = mc.level;
		if (p == null || level == null) {
			finish("left_world");
			return;
		}
		if (System.currentTimeMillis() - startedAt > MAX_MS) {
			finish("time_limit");
			return;
		}

		int s = BotController.selectedSlot(p);
		if (s != slot) {
			slot = s;
			JsonObject d = new JsonObject();
			d.addProperty("slot", s);
			d.addProperty("item", itemId(p.getMainHandItem()));
			// Scrolling through the hotbar makes many selections; only the last one counts.
			if (!steps.isEmpty() && "select".equals(steps.get(steps.size() - 1).get("kind").getAsString())) steps.remove(steps.size() - 1);
			add("select", d);
		}

		Screen open = ContainerHandlers.currentScreen();
		String kind = screenKind(open);
		if (!kind.equals(screen)) {
			onScreen(screen, kind, p);
			screen = kind;
		}

		boolean attack = mc.options.keyAttack.isDown();
		boolean use = mc.options.keyUse.isDown();
		HitResult hit = mc.hitResult;
		if (open == null) {
			if (attack && hit instanceof BlockHitResult bh && hit.getType() == HitResult.Type.BLOCK) {
				BlockState st = level.getBlockState(bh.getBlockPos());
				if (!st.isAir()) {
					if (!bh.getBlockPos().equals(mining)) {
						mining = bh.getBlockPos().immutable();
						miningId = Levels.blockId(st);
					}
					miningAge = 0;
				}
			}
			if (attack && !attackWas && hit instanceof EntityHitResult eh) {
				flushWaypoint(p, ACTION_WAYPOINT_DISTANCE);
				add("attack", entity(eh.getEntity()));
			}
			useHeld = use ? useHeld + 1 : 0;
			if (use && (!useWas || useHeld % USE_REPEAT_TICKS == 0)) onUse(p, level, hit);
		}
		attackWas = attack;
		useWas = use;

		if (mining != null) {
			BlockState now = level.getBlockState(mining);
			if (now.isAir() || !Levels.blockId(now).equals(miningId)) {
				flushWaypoint(p, ACTION_WAYPOINT_DISTANCE);
				JsonObject d = at(mining);
				d.addProperty("block", miningId);
				add("break", d);
				mining = null;
			} else if (!attack && ++miningAge > PENDING_TICKS) {
				mining = null;
			}
		}

		if (usedOn != null) resolveUse(p, level);

		if (recording && p.onGround() && p.position().distanceTo(waypoint) >= WAYPOINT_DISTANCE) addMove(p);
	}

	private static void onUse(LocalPlayer p, ClientLevel level, HitResult hit) {
		if (hit instanceof BlockHitResult bh && hit.getType() == HitResult.Type.BLOCK) {
			usedOn = bh.getBlockPos().immutable();
			placeCell = usedOn.relative(bh.getDirection());
			usedBefore = level.getBlockState(usedOn);
			cellBefore = level.getBlockState(placeCell);
			usedItem = itemId(p.getMainHandItem());
			useAge = 0;
			lastUsed = usedOn;
		} else if (hit instanceof EntityHitResult eh) {
			if (useHeld > 1) return;
			flushWaypoint(p, ACTION_WAYPOINT_DISTANCE);
			JsonObject d = entity(eh.getEntity());
			d.addProperty("item", itemId(p.getMainHandItem()));
			add("use_entity", d);
		} else if (!p.getMainHandItem().isEmpty() && useHeld <= 1) {
			JsonObject d = new JsonObject();
			d.addProperty("item", itemId(p.getMainHandItem()));
			add("use_item", d);
		}
	}

	/** What a use on a block did: placed a block (next to it, or into it when it was replaceable) or changed it. */
	private static void resolveUse(LocalPlayer p, ClientLevel level) {
		BlockState cell = level.getBlockState(placeCell);
		BlockState used = level.getBlockState(usedOn);
		if (cell != cellBefore && !cell.isAir()) {
			place(p, placeCell, cell);
		} else if (used != usedBefore) {
			if (!Levels.blockId(used).equals(Levels.blockId(usedBefore)) && !used.isAir()) {
				place(p, usedOn, used);
			} else {
				flushWaypoint(p, ACTION_WAYPOINT_DISTANCE);
				JsonObject d = at(usedOn);
				d.addProperty("from", Levels.blockState(usedBefore));
				d.addProperty("to", Levels.blockState(used));
				add("use_block", d);
				usedOn = null;
			}
		} else if (++useAge > PENDING_TICKS) {
			usedOn = null;
		}
	}

	private static void place(LocalPlayer p, BlockPos pos, BlockState state) {
		flushWaypoint(p, ACTION_WAYPOINT_DISTANCE);
		JsonObject d = at(pos);
		d.addProperty("state", Levels.blockState(state));
		d.addProperty("item", usedItem);
		add("place", d);
		usedOn = null;
	}

	private static void onScreen(String from, String to, LocalPlayer p) {
		if ("container".equals(to) && lastUsed != null) {
			flushWaypoint(p, ACTION_WAYPOINT_DISTANCE);
			JsonObject d = at(lastUsed);
			d.addProperty("block", Levels.blockId(p.level().getBlockState(lastUsed)));
			add("open_container", d);
			containerBefore = counts(p);
			usedOn = null;
		} else if ("container".equals(from) && containerBefore != null) {
			Map<String, Integer> after = counts(p);
			JsonObject delta = new JsonObject();
			for (String id : union(containerBefore, after)) {
				int change = after.getOrDefault(id, 0) - containerBefore.getOrDefault(id, 0);
				if (change != 0) delta.addProperty(id, change);
			}
			JsonObject d = new JsonObject();
			d.add("inventoryChange", delta);
			add("close_container", d);
			containerBefore = null;
		}
		lastUsed = null;
	}

	/** Screens the recorder cares about: block containers. The player's own inventory is not one. */
	private static String screenKind(Screen s) {
		if (s instanceof InventoryScreen || s instanceof CreativeModeInventoryScreen) return "inventory";
		return SessionScreenHandlers.kind(s);
	}

	private static void flushWaypoint(LocalPlayer p, double min) {
		if (p.position().distanceTo(waypoint) >= min) addMove(p);
	}

	private static void addMove(LocalPlayer p) {
		waypoint = p.position();
		add("move", at(BlockPos.containing(waypoint)));
	}

	private static void add(String kind, JsonObject d) {
		if (!recording) return;
		JsonObject step = new JsonObject();
		step.addProperty("kind", kind);
		step.addProperty("t", System.currentTimeMillis() - startedAt);
		for (Map.Entry<String, com.google.gson.JsonElement> e : d.entrySet()) step.add(e.getKey(), e.getValue());
		steps.add(step);
		if (steps.size() >= MAX_STEPS && !finishing) finish("step_limit");
	}

	/** Ends the recording with an "end" step holding the inventory, so a test can check the result. */
	private static void finish(String reason) {
		if (!recording || finishing) return;
		finishing = true;
		LocalPlayer p = Minecraft.getInstance().player;
		if (p != null) {
			JsonObject end = at(BlockPos.containing(p.position()));
			end.add("inventory", json(counts(p)));
			add("end", end);
		}
		finishing = false;
		recording = false;
		stopReason = reason;
		AiControl.chat(Component.literal("Recording stopped (" + reason.replace('_', ' ') + "), " + steps.size() + " steps."));
	}

	private static void reset() {
		steps.clear();
		stopReason = null;
		mining = null;
		usedOn = null;
		lastUsed = null;
		containerBefore = null;
		attackWas = false;
		useWas = false;
		useHeld = 0;
	}

	private static JsonObject status() {
		JsonObject o = new JsonObject();
		o.addProperty("recording", recording);
		o.addProperty("count", steps.size());
		if (startedAt > 0) o.addProperty("seconds", (System.currentTimeMillis() - startedAt) / 1000);
		if (stopReason != null) o.addProperty("stoppedBy", stopReason);
		o.addProperty("maxSteps", MAX_STEPS);
		return o;
	}

	/** Items in the hotbar, main inventory and offhand (slots 0-35 and 40), as a test's inventoryCount sees them. */
	private static Map<String, Integer> counts(LocalPlayer p) {
		Map<String, Integer> m = new TreeMap<>();
		for (int i = 0; i <= OFFHAND_SLOT && i < p.getInventory().getContainerSize(); i++) {
			if (i >= MAIN_SLOTS && i < OFFHAND_SLOT) continue; // armor
			ItemStack stack = p.getInventory().getItem(i);
			if (!stack.isEmpty()) m.merge(itemId(stack), stack.getCount(), Integer::sum);
		}
		return m;
	}

	private static List<String> union(Map<String, Integer> a, Map<String, Integer> b) {
		TreeMap<String, Integer> all = new TreeMap<>(a);
		all.putAll(b);
		return new ArrayList<>(all.keySet());
	}

	private static JsonObject json(Map<String, Integer> m) {
		JsonObject o = new JsonObject();
		m.forEach(o::addProperty);
		return o;
	}

	private static JsonObject at(BlockPos pos) {
		JsonObject o = new JsonObject();
		o.addProperty("x", pos.getX());
		o.addProperty("y", pos.getY());
		o.addProperty("z", pos.getZ());
		return o;
	}

	private static JsonObject entity(Entity e) {
		JsonObject o = new JsonObject();
		o.addProperty("type", String.valueOf(BuiltInRegistries.ENTITY_TYPE.getKey(e.getType())));
		o.addProperty("uuid", e.getUUID().toString());
		o.addProperty("x", e.getX());
		o.addProperty("y", e.getY());
		o.addProperty("z", e.getZ());
		return o;
	}

	private static String itemId(ItemStack stack) {
		return stack.isEmpty() ? "minecraft:air" : ContainerHandlers.itemId(stack);
	}
}
