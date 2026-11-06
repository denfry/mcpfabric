package dev.mcpfabric.handlers;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.mcpfabric.McpFabric;
import dev.mcpfabric.ServerHolder;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.handlers.support.Takeover;
import net.minecraft.server.MinecraftServer;

/** Status / capability discovery handlers. */
public final class InfoHandlers {
	private InfoHandlers() {}

	public static void register(RpcRouter router) {
		router.register("info.status", ctx -> {
			boolean client = McpFabric.platform().isClient();
			MinecraftServer server = ServerHolder.get();
			boolean serverPresent = server != null;

			JsonObject o = new JsonObject();
			o.addProperty("mod", "mcpfabric");
			o.addProperty("modVersion", McpFabric.platform().modVersion());
			o.addProperty("minecraftVersion", McpFabric.platform().minecraftVersion());
			o.addProperty("loader", McpFabric.platform().loader());
			o.addProperty("side", client ? "client" : "dedicated_server");
			// The player paused the AI (client only): actions are refused until they resume it.
			o.addProperty("aiPaused", Takeover.paused());
			// Groups whose calls wait for the player's approval; a refused one is not to be retried.
			JsonArray approval = new JsonArray();
			McpFabric.config().requireApproval.forEach(approval::add);
			o.add("requireApproval", approval);
			o.addProperty("serverPresent", serverPresent);
			o.addProperty("integratedServer", client && serverPresent);
			// Benign off-thread read (a single int) — intentionally NOT scheduled onto the game thread
			// so get_status stays responsive even when the server thread is busy/stalled.
			o.addProperty("playerCount", serverPresent ? server.getPlayerCount() : 0);
			o.add("capabilities", capabilities(client, serverPresent));
			o.add("methods", router.methodNames());
			return o;
		});

		router.register("info.capabilities", ctx -> {
			boolean client = McpFabric.platform().isClient();
			boolean serverPresent = ServerHolder.isPresent();

			JsonObject groups = new JsonObject();
			groups.addProperty("info", true);
			groups.addProperty("world_read", serverPresent);
			groups.addProperty("world_write", serverPresent && McpFabric.config().enableWorldWrite);
			groups.addProperty("entities", serverPresent);
			groups.addProperty("players_admin", serverPresent && McpFabric.config().enableCommands);
			groups.addProperty("command", serverPresent && McpFabric.config().enableCommands);
			groups.addProperty("player_local", client);
			groups.addProperty("control", client && McpFabric.config().enablePlayerControl);
			groups.addProperty("interact", client && McpFabric.config().enablePlayerControl);
			groups.addProperty("inventory", client && McpFabric.config().enablePlayerControl);
			groups.addProperty("chat", true);
			groups.addProperty("vision", client && McpFabric.config().enableVision);
			groups.addProperty("navigation", client && McpFabric.config().enablePlayerControl);
			groups.addProperty("perception", client && McpFabric.config().enableVision);
			groups.addProperty("containers", client && McpFabric.config().enablePlayerControl);
			groups.addProperty("recipes", client);
			groups.addProperty("crafting", client && McpFabric.config().enablePlayerControl);
			groups.addProperty("session", client && McpFabric.config().enablePlayerControl);
			groups.addProperty("ui", client && McpFabric.config().enablePlayerControl && McpFabric.config().enableUiControl);
			groups.addProperty("supervised", McpFabric.config().enableSupervisedControl);
			groups.addProperty("events", true);

			JsonObject o = new JsonObject();
			o.add("groups", groups);
			return o;
		});
	}

	private static JsonArray capabilities(boolean client, boolean serverPresent) {
		JsonArray a = new JsonArray();
		a.add("info");
		a.add("chat");
		a.add("events");
		if (McpFabric.config().enableSupervisedControl) a.add("supervised");
		if (serverPresent) {
			a.add("world_read");
			a.add("entities");
			if (McpFabric.config().enableWorldWrite) a.add("world_write");
			if (McpFabric.config().enableCommands) {
				a.add("command");
				a.add("players_admin");
			}
		}
		if (client) {
			a.add("player_local");
			a.add("recipes");
			if (McpFabric.config().enablePlayerControl) {
				a.add("inventory");
				a.add("control");
				a.add("interact");
				a.add("navigation");
				a.add("containers");
				a.add("crafting");
				a.add("session");
				if (McpFabric.config().enableUiControl) a.add("ui");
			}
			if (McpFabric.config().enableVision) {
				a.add("vision");
				a.add("perception");
			}
		}
		return a;
	}
}
