package dev.mcpfabric.handlers;

import com.google.gson.JsonObject;
import dev.mcpfabric.McpFabric;
import dev.mcpfabric.ServerHolder;
import dev.mcpfabric.bridge.MainThread;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.events.EventBus;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;

import java.util.List;

/**
 * Chat handlers. {@code chat.getRecent} is environment-agnostic (reads the event ring buffer).
 * {@code chat.send} is registered server-side here (broadcast) and client-side in the client
 * entrypoint (send as the local player) — only one side registers it at runtime.
 */
public final class ChatHandlers {
	private ChatHandlers() {}

	public static void registerCommon(RpcRouter router, EventBus events) {
		router.register("chat.getRecent", ctx -> {
			int limit = ctx.optInt("limit", 50);
			JsonObject o = new JsonObject();
			o.add("messages", events.recent(limit, List.of("chat", "system_message"), 0));
			return o;
		});

		router.register("events.getRecent", ctx -> {
			int limit = ctx.optInt("limit", 50);
			long sinceId = ctx.optLong("sinceId", 0);
			JsonObject o = new JsonObject();
			o.add("events", events.recent(limit, ctx.getStringList("types"), sinceId));
			o.addProperty("lastId", events.lastId());
			return o;
		});
	}

	public static void registerServerChat(RpcRouter router) {
		router.register("chat.send", ctx -> {
			MinecraftServer server = ServerHolder.get();
			if (server == null) throw RpcException.noServer();
			String message = ctx.getString("message");
			return MainThread.call(server, McpFabric.config().callTimeoutMs, () -> {
				server.getPlayerList().broadcastSystemMessage(Component.literal(message), false);
				JsonObject o = new JsonObject();
				o.addProperty("sent", true);
				o.addProperty("broadcast", true);
				return o;
			});
		});
	}
}
