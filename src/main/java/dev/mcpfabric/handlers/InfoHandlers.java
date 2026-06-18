package dev.mcpfabric.handlers;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.mcpfabric.McpFabric;
import dev.mcpfabric.ServerHolder;
import dev.mcpfabric.bridge.RpcRouter;
import net.fabricmc.api.EnvType;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.server.MinecraftServer;

/** Status / capability discovery handlers. */
public final class InfoHandlers {
	private InfoHandlers() {}

	public static void register(RpcRouter router) {
		router.register("info.status", ctx -> {
			EnvType env = FabricLoader.getInstance().getEnvironmentType();
			boolean client = env == EnvType.CLIENT;
			MinecraftServer server = ServerHolder.get();
			boolean serverPresent = server != null;

			JsonObject o = new JsonObject();
			o.addProperty("mod", "mcpfabric");
			o.addProperty("modVersion", McpFabric.MOD_VERSION);
			o.addProperty("minecraftVersion", McpFabric.MC_VERSION);
			o.addProperty("side", client ? "client" : "dedicated_server");
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
			EnvType env = FabricLoader.getInstance().getEnvironmentType();
			boolean client = env == EnvType.CLIENT;
			boolean serverPresent = ServerHolder.isPresent();

			JsonObject groups = new JsonObject();
			groups.addProperty("info", true);
			groups.addProperty("world_read", serverPresent);
			groups.addProperty("world_write", serverPresent && McpFabric.config().enableWorldWrite);
			groups.addProperty("entities", serverPresent);
			groups.addProperty("players_admin", serverPresent);
			groups.addProperty("command", serverPresent && McpFabric.config().enableCommands);
			groups.addProperty("player_local", client);
			groups.addProperty("control", client && McpFabric.config().enablePlayerControl);
			groups.addProperty("interact", client && McpFabric.config().enablePlayerControl);
			groups.addProperty("inventory", client);
			groups.addProperty("chat", true);
			groups.addProperty("vision", client && McpFabric.config().enableVision);
			groups.addProperty("navigation", client && McpFabric.config().enablePlayerControl);
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
		if (serverPresent) {
			a.add("world_read");
			a.add("entities");
			a.add("players_admin");
			if (McpFabric.config().enableWorldWrite) a.add("world_write");
			if (McpFabric.config().enableCommands) a.add("command");
		}
		if (client) {
			a.add("player_local");
			a.add("inventory");
			if (McpFabric.config().enablePlayerControl) {
				a.add("control");
				a.add("interact");
				a.add("navigation");
			}
			if (McpFabric.config().enableVision) a.add("vision");
		}
		return a;
	}
}
