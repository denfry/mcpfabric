package dev.mcpfabric.client.handlers;

import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.Window;
import dev.mcpfabric.McpFabric;
import dev.mcpfabric.bridge.Json;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.client.ClientCompat;
import dev.mcpfabric.client.ClientMc;
import net.minecraft.client.Minecraft;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Window and option control for layout checks and clean screenshots: window size, GUI scale,
 * language, HUD visibility, pause-on-focus-loss.
 */
public final class ClientOptionHandlers {
	private static final AtomicBoolean PAUSE_OFF_APPLIED = new AtomicBoolean();

	private ClientOptionHandlers() {}

	public static void register(RpcRouter router) {
		router.register("client.setWindow", ctx -> ClientMc.call(() -> {
			requireControl();
			int width = ctx.getInt("width");
			int height = ctx.getInt("height");
			if (width < 320 || height < 240) throw RpcException.badRequest("The window must be at least 320x240.");
			Minecraft mc = ClientMc.mc();
			ClientCompat.leaveFullscreen(mc);
			mc.getWindow().setWindowed(width, height);
			return windowState(mc);
		}));

		router.register("client.setGuiScale", ctx -> ClientMc.call(() -> {
			requireControl();
			int scale = ctx.getInt("scale");
			if (scale < 0) throw RpcException.badRequest("scale must be 0 (auto) or more.");
			Minecraft mc = ClientMc.mc();
			mc.options.guiScale().set(scale);
			mc.options.save();
			ClientCompat.resizeGui(mc);
			return windowState(mc);
		}));

		router.register("client.setLanguage", ctx -> ClientMc.call(() -> {
			requireControl();
			String code = ctx.getString("code").toLowerCase(java.util.Locale.ROOT);
			Minecraft mc = ClientMc.mc();
			if (mc.getLanguageManager().getLanguage(code) == null) {
				throw RpcException.notFound("Unknown language '" + code + "'.");
			}
			boolean changed = !code.equals(mc.options.languageCode);
			if (changed) {
				mc.getLanguageManager().setSelected(code);
				mc.options.languageCode = code;
				mc.options.save();
				mc.reloadResourcePacks();
			}
			JsonObject o = Json.ok(changed ? "reloading resources for " + code : "already " + code);
			o.addProperty("language", code);
			o.addProperty("reloading", changed);
			return o;
		}));

		router.register("client.setHudHidden", ctx -> ClientMc.call(() -> {
			ClientCompat.setHudHidden(ClientMc.mc(), ctx.optBool("hidden", true));
			JsonObject o = new JsonObject();
			o.addProperty("hudHidden", ClientCompat.hudHidden(ClientMc.mc()));
			return o;
		}));

		router.register("client.setPauseOnLostFocus", ctx -> ClientMc.call(() -> {
			PAUSE_OFF_APPLIED.set(true); // an explicit choice wins over the automatic one
			ClientMc.mc().options.pauseOnLostFocus = ctx.optBool("enabled", true);
			JsonObject o = new JsonObject();
			o.addProperty("pauseOnLostFocus", ClientMc.mc().options.pauseOnLostFocus);
			return o;
		}));
	}

	/**
	 * Called before every RPC: the first time the bridge is used, stop the game from pausing when
	 * its window loses focus (config {@code keepRunningUnfocused}), since an agent drives a window that
	 * usually is not in front. Only the in-memory option changes; it reaches options.txt when the
	 * game next saves its options.
	 */
	public static void onBridgeCall() {
		if (!McpFabric.config().keepRunningUnfocused || PAUSE_OFF_APPLIED.get()) return;
		Minecraft mc = ClientMc.mc();
		if (mc == null || mc.options == null) return;
		if (PAUSE_OFF_APPLIED.compareAndSet(false, true)) {
			mc.execute(() -> mc.options.pauseOnLostFocus = false);
		}
	}

	private static JsonObject windowState(Minecraft mc) {
		Window w = mc.getWindow();
		JsonObject o = new JsonObject();
		o.addProperty("width", w.getWidth());
		o.addProperty("height", w.getHeight());
		o.addProperty("fullscreen", mc.options.fullscreen().get());
		o.addProperty("guiScaleOption", mc.options.guiScale().get());
		o.addProperty("guiScale", w.getGuiScale());
		o.addProperty("scaledWidth", w.getGuiScaledWidth());
		o.addProperty("scaledHeight", w.getGuiScaledHeight());
		return o;
	}

	private static void requireControl() throws RpcException {
		if (!McpFabric.config().enablePlayerControl) {
			throw RpcException.unavailable("Player control is disabled in mcpfabric.config.json (enablePlayerControl=false).");
		}
	}
}
