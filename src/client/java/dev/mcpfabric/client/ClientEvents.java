package dev.mcpfabric.client;

import com.google.gson.JsonObject;
import dev.mcpfabric.McpFabric;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.Holder;
import net.minecraft.network.chat.ChatType;
import net.minecraft.network.chat.Component;

/**
 * Client-side events that feed the shared {@link dev.mcpfabric.events.EventBus}. The loader client
 * entrypoint forwards its own chat events here; {@link McpFabricClient#onClientTick} drives the
 * local player watch.
 */
public final class ClientEvents {
	private ClientEvents() {}

	/** Health of the local player at the last tick; negative outside a world. */
	private static float lastHealth = -1f;
	private static boolean wasDead;

	/** A system / game message was shown (overlay = action bar). */
	public static void onSystemMessage(Component message, boolean overlay) {
		JsonObject d = new JsonObject();
		d.addProperty("text", message.getString());
		d.addProperty("overlay", overlay);
		McpFabric.events().emit("system_message", d);
	}

	/**
	 * A player chat message was received; {@code sender} is null when unknown. {@code kind} says how
	 * it was sent (chat, whisper_in, whisper_out, team, say, emote, other) and {@code self} marks the
	 * local player's own messages.
	 */
	public static void onChatMessage(Component message, String sender, ChatType.Bound bound) {
		JsonObject d = new JsonObject();
		d.addProperty("text", message.getString());
		if (sender != null) {
			d.addProperty("sender", sender);
			LocalPlayer self = Minecraft.getInstance().player;
			if (self != null && sender.equals(self.getName().getString())) d.addProperty("self", true);
		}
		d.addProperty("kind", chatKind(bound));
		McpFabric.events().emit("chat", d);
	}

	private static String chatKind(ChatType.Bound bound) {
		if (bound == null) return "other";
		Holder<ChatType> type = bound.chatType();
		if (type.is(ChatType.CHAT)) return "chat";
		if (type.is(ChatType.MSG_COMMAND_INCOMING)) return "whisper_in";
		if (type.is(ChatType.MSG_COMMAND_OUTGOING)) return "whisper_out";
		if (type.is(ChatType.TEAM_MSG_COMMAND_INCOMING) || type.is(ChatType.TEAM_MSG_COMMAND_OUTGOING)) return "team";
		if (type.is(ChatType.SAY_COMMAND)) return "say";
		if (type.is(ChatType.EMOTE_COMMAND)) return "emote";
		return "other";
	}

	/**
	 * End of a client tick: reports the local player losing health ({@code self_health}) and dying
	 * ({@code self_death}). Works on any server, as it only reads the client's own player.
	 */
	public static void onClientTick(Minecraft mc) {
		LocalPlayer p = mc.player;
		if (mc.level == null || p == null) {
			lastHealth = -1f;
			wasDead = false;
			return;
		}
		float health = p.getHealth();
		boolean dead = p.isDeadOrDying();
		if (dead && !wasDead) {
			McpFabric.events().emit("self_death", new JsonObject());
		} else if (!dead && lastHealth >= 0f && health < lastHealth) {
			JsonObject d = new JsonObject();
			d.addProperty("health", health);
			d.addProperty("maxHealth", p.getMaxHealth());
			d.addProperty("lost", lastHealth - health);
			McpFabric.events().emit("self_health", d);
		}
		lastHealth = health;
		wasDead = dead;
	}

	/** The client left the world; {@code screen} is the coarse kind of the screen it went to. */
	public static void onLeftWorld(String screen) {
		JsonObject d = new JsonObject();
		d.addProperty("screen", screen);
		d.addProperty("disconnected", "disconnected".equals(screen));
		McpFabric.events().emit("left_world", d);
	}
}
