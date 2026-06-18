package dev.mcpfabric.client;

import com.google.gson.JsonObject;
import dev.mcpfabric.events.EventBus;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;

/** Client-side event listeners that feed the shared {@link EventBus}. */
public final class ClientEvents {
	private ClientEvents() {}

	public static void register(EventBus events) {
		ClientReceiveMessageEvents.GAME.register((message, overlay) -> {
			JsonObject d = new JsonObject();
			d.addProperty("text", message.getString());
			d.addProperty("overlay", overlay);
			events.emit("system_message", d);
		});

		ClientReceiveMessageEvents.CHAT.register((message, signedMessage, sender, params, receptionTimestamp) -> {
			JsonObject d = new JsonObject();
			d.addProperty("text", message.getString());
			if (sender != null) {
				//? if <1.21.9 {
				d.addProperty("sender", sender.getName());
				//?} else
				/*d.addProperty("sender", sender.name());*/
			}
			events.emit("chat", d);
		});
	}
}
