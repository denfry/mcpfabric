package dev.mcpfabric.client.handlers;

import com.google.gson.JsonObject;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.client.AiControl;
import dev.mcpfabric.client.ClientMc;
import dev.mcpfabric.handlers.support.Gates;
import net.minecraft.client.player.LocalPlayer;

/**
 * Client-side {@code chat.send}: speak as the local player (a leading '/' runs a command), and
 * {@code chat.showLocal}: show the player a message from the AI that only they see.
 */
public final class ClientChatHandlers {
	private static final int MAX_LOCAL_MESSAGE = 512;

	private ClientChatHandlers() {}

	public static void register(RpcRouter router) {
		router.register("chat.send", ctx -> ClientMc.call(() -> {
			// Speaks to the server as the player, so it stops while the player has paused the AI.
			Gates.notPaused();
			LocalPlayer p = ClientMc.player();
			String message = ctx.getString("message");
			boolean isCommand = message.startsWith("/");
			if (isCommand) {
				// Runs with the player's permissions, which in single player with cheats is operator level.
				Gates.commands();
				p.connection.sendCommand(message.substring(1));
			} else {
				p.connection.sendChat(message);
			}
			JsonObject o = new JsonObject();
			o.addProperty("sent", true);
			o.addProperty("asCommand", isCommand);
			return o;
		}));

		// Prints to the local player only, nothing reaches the server or other players; it needs no
		// lock and stays available while the player has paused the AI (it is how the AI answers then).
		router.register("chat.showLocal", ctx -> {
			String text = ctx.getString("text");
			boolean actionBar = ctx.optBool("actionBar", false);
			// Formatting codes and control characters could fake other messages; the [AI] prefix stays.
			String clean = text.replaceAll("[\\u00a7\\p{Cntrl}]", "");
			if (clean.isBlank()) throw RpcException.badRequest("text is empty");
			if (clean.length() > MAX_LOCAL_MESSAGE) clean = clean.substring(0, MAX_LOCAL_MESSAGE) + "...";
			String shown = clean;
			return ClientMc.call(() -> {
				ClientMc.player();
				AiControl.showFromAi(shown, actionBar);
				JsonObject o = new JsonObject();
				o.addProperty("shown", true);
				o.addProperty("length", shown.length());
				return o;
			});
		});
	}
}
