package dev.mcpfabric.client;

import com.mojang.blaze3d.platform.Window;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.worldselection.CreateWorldScreen;
import org.jetbrains.annotations.Nullable;

/**
 * Client APIs that moved between versions, behind one name each: the open screen (a field on
 * {@code Minecraft} until 26.2, then owned by {@code Gui}), the HUD toggle (an option until 26.2,
 * then {@code Hud}), window fullscreen and GUI resizing.
 */
public final class ClientCompat {
	private ClientCompat() {}

	@Nullable
	public static Screen screen(Minecraft mc) {
		//? if <26.2 {
		return mc.screen;
		//?} else
		/*return mc.gui.screen();*/
	}

	public static void setScreen(Minecraft mc, @Nullable Screen screen) {
		//? if <26.2 {
		mc.setScreen(screen);
		//?} else
		/*mc.gui.setScreen(screen);*/
	}

	/** Class name of the open screen, or null. */
	@Nullable
	public static String screenName(Minecraft mc) {
		Screen s = screen(mc);
		return s == null ? null : s.getClass().getName();
	}

	public static boolean hudHidden(Minecraft mc) {
		//? if <26.2 {
		return mc.options.hideGui;
		//?} else
		/*return mc.gui.hud.isHidden();*/
	}

	public static void setHudHidden(Minecraft mc, boolean hidden) {
		//? if <26.2 {
		mc.options.hideGui = hidden;
		//?} else
		/*if (mc.gui.hud.isHidden() != hidden) mc.gui.hud.toggle();*/
	}

	/** Leave fullscreen so the window can be resized. */
	public static void leaveFullscreen(Minecraft mc) {
		Window window = mc.getWindow();
		//? if <26.3 {
		if (window.isFullscreen()) window.toggleFullScreen();
		//?} else {
		/*if (mc.options.fullscreen().get()) {
			mc.options.fullscreen().set(false);
			window.setFullscreen(false);
		}
		*///?}
	}

	/** Recompute the GUI scale and re-lay out the open screen after a scale change. */
	public static void resizeGui(Minecraft mc) {
		//? if <26.1 {
		mc.resizeDisplay();
		//?} else
		/*mc.resizeGui();*/
	}

	/** Open the create-world screen; cancelling it goes back to {@code parent}. */
	public static void openCreateWorld(Minecraft mc, @Nullable Screen parent) {
		//? if <1.21.9 {
		CreateWorldScreen.openFresh(mc, parent);
		//?} else
		/*CreateWorldScreen.openFresh(mc, () -> setScreen(mc, parent));*/
	}
}
