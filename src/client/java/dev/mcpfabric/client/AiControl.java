package dev.mcpfabric.client;

import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.mcpfabric.McpFabric;
import dev.mcpfabric.handlers.support.Takeover;
import net.minecraft.ChatFormatting;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.ChatComponent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;

/**
 * The player's side of {@link Takeover}: one key (K by default, rebindable under Controls) and
 * {@code /mcpfabric stop|resume|status} pause and resume the AI. Pausing releases every key the
 * bot holds, stops navigation and mining, and fences supervised grants; while paused, actions over
 * the bridge are refused. The action bar says when the AI takes control after a quiet spell, so the
 * player always knows who is moving.
 */
public final class AiControl {
	/** After this long without an action, the next one shows the "AI has control" hint again. */
	private static final long IDLE_MILLIS = 15_000;

	//? if <1.21.9 {
	public static final KeyMapping TOGGLE_KEY = new KeyMapping("key.mcpfabric.toggle_ai", InputConstants.Type.KEYSYM, InputConstants.KEY_K, "key.categories.misc");
	//?} else if <26.3 {
	/*public static final KeyMapping TOGGLE_KEY = new KeyMapping("key.mcpfabric.toggle_ai", InputConstants.Type.KEYSYM, InputConstants.KEY_K, KeyMapping.Category.MISC);*/
	//?} else
	/*public static final KeyMapping TOGGLE_KEY = new KeyMapping("key.mcpfabric.toggle_ai", InputConstants.Type.KEYBOARD, InputConstants.KEY_K, KeyMapping.Category.MISC);*/

	private static long hintedAction;

	private AiControl() {}

	/** End of every client tick: the toggle key, and the hint when the AI starts acting. */
	public static void onClientTick(Minecraft mc) {
		while (TOGGLE_KEY.consumeClick()) {
			if (Takeover.paused()) resume();
			else pause();
		}
		long last = Takeover.lastActionMillis();
		if (last != 0 && last != hintedAction && mc.player != null) {
			if (last - hintedAction > IDLE_MILLIS) {
				overlay(Component.literal("AI has control. Press ")
						.append(keyName())
						.append(" to take it back."));
			}
			hintedAction = last;
		}
	}

	public static void pause() {
		if (Takeover.paused()) {
			chat(Component.literal("The AI is already paused. ").append(resumeHint()));
			return;
		}
		Takeover.setPaused(true);
		BotController bot = BotController.get();
		bot.stopNavigation("paused by the player");
		bot.stopMining();
		bot.stopAllMovement();
		Minecraft mc = Minecraft.getInstance();
		mc.options.keyUse.setDown(false);
		if (mc.player != null && mc.player.isUsingItem()) mc.player.stopUsingItem();
		McpFabric.supervisor().stop();
		McpFabric.events().emit("ai_paused", new JsonObject());
		overlay(Component.literal("AI paused: you have control."));
		chat(Component.literal("AI paused. Its actions are refused until you resume. ").append(resumeHint()));
	}

	public static void resume() {
		if (!Takeover.paused()) {
			chat(Component.literal("The AI is not paused. Press ").append(keyName()).append(" or run /mcpfabric stop to pause it."));
			return;
		}
		Takeover.setPaused(false);
		McpFabric.events().emit("ai_resumed", new JsonObject());
		overlay(Component.literal("AI resumed."));
		chat(Component.literal("AI resumed. Press ").append(keyName()).append(" or run /mcpfabric stop to pause it again."));
	}

	public static void status() {
		boolean server = Minecraft.getInstance().getSingleplayerServer() != null;
		String state = Takeover.paused() ? "paused (you have control)" : "active";
		chat(Component.literal("AI " + state + ". Bridge on " + McpFabric.config().host + ":" + McpFabric.config().port
				+ (server ? ", integrated server" : "") + ". Toggle with ").append(keyName()).append("."));
	}

	/** A message from the AI to the local player only: chat (or the action bar), never sent to the server. */
	public static void showFromAi(String text, boolean actionBar) {
		Component message = Component.literal(text);
		if (actionBar) {
			overlay(Component.literal("[AI] ").withStyle(ChatFormatting.AQUA).append(message));
		} else {
			addChat(Component.literal("[AI] ").withStyle(ChatFormatting.AQUA).append(message));
		}
	}

	private static Component resumeHint() {
		return Component.literal("Press ").append(keyName()).append(" or run /mcpfabric resume.");
	}

	private static MutableComponent keyName() {
		return TOGGLE_KEY.getTranslatedKeyMessage().copy().withStyle(ChatFormatting.YELLOW);
	}

	private static void chat(Component text) {
		addChat(Component.literal("[mcpfabric] ").withStyle(ChatFormatting.GOLD).append(text));
	}

	/** A client-side line in chat; it is never sent to the server. */
	private static void addChat(Component line) {
		//? if <26.1 {
		chatComponent().addMessage(line);
		//?} else
		/*chatComponent().addClientSystemMessage(line);*/
	}

	private static ChatComponent chatComponent() {
		//? if <26.2 {
		return Minecraft.getInstance().gui.getChat();
		//?} else
		/*return Minecraft.getInstance().gui.hud.getChat();*/
	}

	private static void overlay(Component text) {
		//? if <26.2 {
		Minecraft.getInstance().gui.setOverlayMessage(text, false);
		//?} else
		/*Minecraft.getInstance().gui.hud.setOverlayMessage(text, false);*/
	}
}
