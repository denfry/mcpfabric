package dev.mcpfabric.handlers;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.mcpfabric.McpFabric;
import dev.mcpfabric.ServerHolder;
import dev.mcpfabric.bridge.MainThread;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.handlers.support.DevInspect;
import dev.mcpfabric.handlers.support.DevInspect.Box;
import dev.mcpfabric.handlers.support.Gates;
import dev.mcpfabric.handlers.support.Levels;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.ai.Brain;
import net.minecraft.world.entity.ai.behavior.BehaviorControl;
import net.minecraft.world.entity.ai.goal.GoalSelector;
import net.minecraft.world.entity.ai.goal.WrappedGoal;
import net.minecraft.world.entity.ai.memory.MemoryModuleType;
import net.minecraft.world.entity.schedule.Activity;
import net.minecraft.world.level.block.state.BlockState;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Developer tools that look into the running world ({@code dev.watch}, {@code dev.brain}), behind
 * {@code enableDevTools}: which blocks in a region change tick by tick, and what a mob is thinking
 * (goals, brain activities and memories, navigation, target).
 */
public final class DevWorldHandlers {
	/** Most positions one watch may sample every tick (32x32x32). */
	static final int MAX_WATCH_VOLUME = 32_768;
	static final int MAX_WATCH_TICKS = 200;
	static final int MAX_WATCH_CHANGES = 1000;
	/** Wall-clock bound of one watch, under the MCP server's default 15 s request timeout. */
	private static final long WATCH_WALL_MS = 10_000;
	private static final long TICK_MS = 50;
	static final int MAX_LIST = 64;

	private DevWorldHandlers() {}

	public static void register(RpcRouter router) {
		router.register("dev.watch", ctx -> {
			Gates.devTools();
			MinecraftServer server = ServerHolder.get();
			if (server == null) throw RpcException.noServer();
			double[] from = ctx.getVec3("from");
			double[] to = ctx.getVec3("to");
			int ticks = ctx.optInt("ticks", 40);
			int maxChanges = ctx.optInt("maxChanges", 200);
			if (ticks < 1 || ticks > MAX_WATCH_TICKS) throw RpcException.badRequest("ticks must be 1-" + MAX_WATCH_TICKS + ".");
			if (maxChanges < 1 || maxChanges > MAX_WATCH_CHANGES) throw RpcException.badRequest("maxChanges must be 1-" + MAX_WATCH_CHANGES + ".");
			BlockPos a = BlockPos.containing(from[0], from[1], from[2]), b = BlockPos.containing(to[0], to[1], to[2]);
			Box box = Box.of(a.getX(), a.getY(), a.getZ(), b.getX(), b.getY(), b.getZ());
			if (box.volume() > MAX_WATCH_VOLUME) {
				throw RpcException.badRequest("Region has " + box.volume() + " positions; the limit is " + MAX_WATCH_VOLUME
						+ " (for example 32x32x32). Watch a smaller region.");
			}
			String dimension = ctx.optString("dimension", null);
			long timeout = McpFabric.config().callTimeoutMs;

			Object[] start = MainThread.call(server, timeout, () -> {
				ServerLevel level = Levels.resolve(server, dimension);
				return new Object[] {level, sample(level, box), server.getTickCount()};
			});
			ServerLevel level = (ServerLevel) start[0];
			BlockState[] previous = (BlockState[]) start[1];
			int startTick = (int) start[2];

			JsonArray changes = new JsonArray();
			int samples = 0;
			boolean truncated = false;
			long deadline = System.currentTimeMillis() + WATCH_WALL_MS;
			int lastTick = startTick;
			// Sampled once per tick on the server thread; a block that changes and changes back within
			// one tick is not seen.
			while (lastTick - startTick < ticks && System.currentTimeMillis() < deadline && !truncated) {
				try {
					Thread.sleep(TICK_MS);
				} catch (InterruptedException e) {
					Thread.currentThread().interrupt();
					break;
				}
				if (ServerHolder.get() != server) break;
				Object[] now = MainThread.call(server, timeout, () -> new Object[] {sample(level, box), server.getTickCount()});
				BlockState[] current = (BlockState[]) now[0];
				lastTick = (int) now[1];
				samples++;
				truncated = DevInspect.diff(box, previous, current, lastTick - startTick, changes, maxChanges, Levels::blockState);
				previous = current;
			}

			JsonObject o = new JsonObject();
			o.addProperty("dimension", Levels.dimensionId(level));
			o.addProperty("volume", box.volume());
			o.addProperty("ticks", lastTick - startTick);
			o.addProperty("samples", samples);
			o.addProperty("count", changes.size());
			o.addProperty("truncated", truncated);
			o.add("changes", changes);
			return o;
		});

		router.register("dev.brain", ctx -> {
			Gates.devTools();
			MinecraftServer server = ServerHolder.get();
			if (server == null) throw RpcException.noServer();
			UUID uuid;
			try {
				uuid = UUID.fromString(ctx.getString("uuid"));
			} catch (IllegalArgumentException e) {
				throw RpcException.badRequest("Invalid UUID: " + ctx.getString("uuid"));
			}
			return MainThread.call(server, McpFabric.config().callTimeoutMs, () -> {
				for (ServerLevel level : server.getAllLevels()) {
					Entity e = level.getEntity(uuid);
					if (e == null) continue;
					if (!(e instanceof LivingEntity le)) throw RpcException.badRequest("Entity " + uuid + " is not a living entity.");
					JsonObject o = brain(le);
					o.addProperty("dimension", Levels.dimensionId(level));
					return o;
				}
				throw RpcException.notFound("No entity with uuid " + uuid);
			});
		});
	}

	/** Block states of the region in y, x, z order; null where the chunk is not loaded. */
	private static BlockState[] sample(ServerLevel level, Box box) {
		BlockState[] out = new BlockState[(int) box.volume()];
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		int i = 0;
		for (int y = box.minY(); y <= box.maxY(); y++) {
			for (int x = box.minX(); x <= box.maxX(); x++) {
				for (int z = box.minZ(); z <= box.maxZ(); z++) {
					m.set(x, y, z);
					out[i++] = level.hasChunkAt(m) ? level.getBlockState(m) : null;
				}
			}
		}
		return out;
	}

	private static JsonObject brain(LivingEntity le) {
		JsonObject o = new JsonObject();
		o.addProperty("uuid", le.getUUID().toString());
		o.addProperty("type", String.valueOf(BuiltInRegistries.ENTITY_TYPE.getKey(le.getType())));
		o.addProperty("name", le.getName().getString());
		o.addProperty("x", le.getX());
		o.addProperty("y", le.getY());
		o.addProperty("z", le.getZ());
		if (le instanceof Mob mob) {
			LivingEntity target = mob.getTarget();
			if (target != null) {
				JsonObject t = new JsonObject();
				t.addProperty("uuid", target.getUUID().toString());
				t.addProperty("type", String.valueOf(BuiltInRegistries.ENTITY_TYPE.getKey(target.getType())));
				t.addProperty("name", target.getName().getString());
				o.add("target", t);
			}
			JsonObject nav = new JsonObject();
			nav.addProperty("done", mob.getNavigation().isDone());
			BlockPos goal = mob.getNavigation().getTargetPos();
			if (goal != null && !mob.getNavigation().isDone()) {
				nav.addProperty("x", goal.getX());
				nav.addProperty("y", goal.getY());
				nav.addProperty("z", goal.getZ());
			}
			o.add("navigation", nav);
			addGoals(o, mob);
		}
		addBrain(o, le.getBrain());
		return o;
	}

	/**
	 * Mob.goalSelector and targetSelector are protected (a public getter exists only in newer
	 * versions), so they are found by type, which does not depend on mappings. Declaration order
	 * gives which is which.
	 */
	private static void addGoals(JsonObject o, Mob mob) {
		List<GoalSelector> selectors = new ArrayList<>();
		try {
			for (Field f : Mob.class.getDeclaredFields()) {
				if (f.getType() != GoalSelector.class || Modifier.isStatic(f.getModifiers())) continue;
				f.setAccessible(true);
				selectors.add((GoalSelector) f.get(mob));
			}
		} catch (RuntimeException | IllegalAccessException e) {
			o.addProperty("goalsUnavailable", "The goal selectors could not be read: " + e.getClass().getSimpleName());
			return;
		}
		if (selectors.size() != 2) {
			o.addProperty("goalsUnavailable", "Expected 2 goal selectors, found " + selectors.size() + ".");
			return;
		}
		o.add("goals", goals(selectors.get(0)));
		o.add("targetGoals", goals(selectors.get(1)));
	}

	private static JsonArray goals(GoalSelector selector) {
		List<WrappedGoal> list = new ArrayList<>(selector.getAvailableGoals());
		list.sort(Comparator.comparingInt(WrappedGoal::getPriority));
		JsonArray a = new JsonArray();
		for (WrappedGoal g : list.subList(0, Math.min(MAX_LIST, list.size()))) {
			JsonObject e = new JsonObject();
			e.addProperty("goal", DevInspect.className(g.getGoal().getClass()));
			e.addProperty("priority", g.getPriority());
			e.addProperty("running", g.isRunning());
			a.add(e);
		}
		return a;
	}

	@SuppressWarnings({"unchecked", "rawtypes"})
	private static void addBrain(JsonObject o, Brain<?> brain) {
		JsonObject b = new JsonObject();
		JsonArray activities = new JsonArray();
		for (Activity a : brain.getActiveActivities()) activities.add(a.getName());
		b.add("activities", activities);
		JsonArray running = new JsonArray();
		List<? extends BehaviorControl<?>> behaviors = brain.getRunningBehaviors();
		for (BehaviorControl<?> c : behaviors.subList(0, Math.min(MAX_LIST, behaviors.size()))) running.add(c.debugString());
		b.add("runningBehaviors", running);
		// Every memory type is asked, since newer versions no longer list the brain's own memories.
		JsonObject memories = new JsonObject();
		Registry types = BuiltInRegistries.MEMORY_MODULE_TYPE;
		for (Object t : types) {
			if (memories.size() >= MAX_LIST) break;
			MemoryModuleType type = (MemoryModuleType) t;
			try {
				if (!brain.hasMemoryValue(type)) continue;
				Optional<?> value = brain.getMemory(type);
				if (value.isEmpty()) continue;
				memories.addProperty(String.valueOf(types.getKey(type)), value(value.get()));
			} catch (RuntimeException ignored) {
				// A memory the brain does not register; nothing to show.
			}
		}
		b.add("memories", memories);
		o.add("brain", b);
	}

	/** A memory value as short text: entities by type and uuid. */
	private static String value(Object v) {
		if (v instanceof Entity e) return BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()) + " " + e.getUUID();
		return DevInspect.shortText(v);
	}
}
