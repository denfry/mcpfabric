package dev.mcpfabric.client.handlers;

import com.google.gson.JsonObject;
import dev.mcpfabric.McpFabric;
import dev.mcpfabric.bridge.Json;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.client.BotController;
import dev.mcpfabric.client.ClientMc;
import dev.mcpfabric.client.nav.AStarPathfinder;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;

import java.util.List;

/** A* navigation: start walking to a target, query status, stop. */
public final class NavHandlers {
	private static final int NODE_BUDGET = 12000;

	private NavHandlers() {}

	public static void register(RpcRouter router) {
		router.register("nav.pathTo", ctx -> ClientMc.call(() -> {
			if (!McpFabric.config().enablePlayerControl) {
				throw RpcException.unavailable("Player control is disabled (enablePlayerControl=false).");
			}
			LocalPlayer p = ClientMc.player();
			ClientLevel level = ClientMc.level();
			BlockPos start = p.blockPosition();
			BlockPos goal = BlockPos.containing(ctx.getDouble("x"), ctx.getDouble("y"), ctx.getDouble("z"));
			double reach = ctx.optDouble("reachRadius", 1.0);
			boolean sprint = ctx.optBool("sprint", false);
			int timeout = ctx.optInt("timeoutSeconds", 60);

			AStarPathfinder pf = new AStarPathfinder(level, NODE_BUDGET);
			List<BlockPos> path = pf.findPath(start, goal, reach);
			if (path == null || path.isEmpty()) {
				throw RpcException.notFound("No path found to target within the search budget (try a closer/standable target).");
			}
			long deadline = System.currentTimeMillis() + timeout * 1000L;
			BotController.get().startNavigation(path, goal, reach, sprint, deadline);

			JsonObject o = new JsonObject();
			o.addProperty("started", true);
			o.addProperty("pathLength", path.size());
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
}
