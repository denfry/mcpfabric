package dev.mcpfabric.client.handlers;

import com.google.gson.JsonObject;
import dev.mcpfabric.bridge.Json;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.client.BotController;
import dev.mcpfabric.client.ClientMc;
import dev.mcpfabric.client.nav.LevelNavWorld;
import dev.mcpfabric.handlers.support.Gates;
import dev.mcpfabric.nav.NavPlanner;
import dev.mcpfabric.nav.NavPos;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;

import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** A* navigation: start walking to a target, query status, stop. */
public final class NavHandlers {
	private static final int NODE_BUDGET = 12000;

	private NavHandlers() {}

	public static void register(RpcRouter router) {
		router.register("nav.pathTo", ctx -> ClientMc.call(() -> {
			Gates.playerControl();
			LocalPlayer p = ClientMc.player();
			ClientLevel level = ClientMc.level();
			BlockPos start = p.blockPosition();
			BlockPos goal = BlockPos.containing(ctx.getDouble("x"), ctx.getDouble("y"), ctx.getDouble("z"));
			double reach = ctx.optDouble("reachRadius", 1.0);
			boolean sprint = ctx.optBool("sprint", false);
			int timeout = ctx.optInt("timeoutSeconds", 60);
			boolean dig = ctx.optBool("allowDig", true);
			boolean pillar = ctx.optBool("allowPillar", true);
			boolean swim = ctx.optBool("allowSwim", true);
			int blocks = pillar ? LevelNavWorld.throwawayCount(p) : 0;

			NavPlanner planner = new NavPlanner(new LevelNavWorld(level, p),
					new NavPlanner.Options(dig, pillar && blocks > 0, swim, blocks, NODE_BUDGET));
			List<NavPlanner.Step> path = planner.findPath(pos(start), pos(goal), reach);
			if (path == null || path.isEmpty()) {
				throw RpcException.notFound("No path found to target within the search budget (try a closer target"
						+ (dig && swim && blocks > 0 ? ")." : ", or allow digging, swimming or pillaring with throwaway blocks in the hotbar)."));
			}
			long deadline = System.currentTimeMillis() + timeout * 1000L;
			BotController.get().startNavigation(path, start, goal, reach, sprint, deadline);

			JsonObject o = new JsonObject();
			o.addProperty("started", true);
			o.addProperty("pathLength", path.size());
			Map<String, Integer> counts = new TreeMap<>();
			for (NavPlanner.Step step : path) counts.merge(step.move().id(), 1, Integer::sum);
			JsonObject moves = new JsonObject();
			counts.forEach(moves::addProperty);
			o.add("moves", moves);
			JsonObject g = new JsonObject();
			g.addProperty("x", goal.getX());
			g.addProperty("y", goal.getY());
			g.addProperty("z", goal.getZ());
			o.add("goal", g);
			return o;
		}));

		router.register("nav.status", ctx -> ClientMc.call(() -> BotController.get().statusJson()));

		router.register("nav.stop", ctx -> {
			BotController.get().stopNavigation("stopped");
			BotController.get().stopAllMovement();
			return Json.ok("navigation stopped");
		});
	}

	private static NavPos pos(BlockPos p) {
		return new NavPos(p.getX(), p.getY(), p.getZ());
	}
}
