package dev.mcpfabric.client;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
//? if >=1.21.9 {
/*import net.minecraft.client.KeyboardHandler;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.input.MouseButtonInfo;
*///?}
//? if >=1.21.9 <26.1 {
/*import org.lwjgl.glfw.GLFW;
import org.lwjgl.glfw.GLFWKeyCallback;
*///?}

/**
 * Synthetic keyboard and mouse input, delivered through the same entry points the window's input
 * callbacks use, so screens, key bindings and debug keys react as they would to a real player.
 * 1.21.9 replaced the loose {@code (x, y, button)} / {@code (key, scancode, modifiers)} arguments
 * with event records.
 */
public final class GuiInput {
	public static final int RELEASE = 0;
	public static final int PRESS = 1;

	/** Modifier bits, as the window callbacks report them (26.3 moved from GLFW to SDL). */
	//? if <26.3 {
	public static final int MOD_SHIFT = 1;
	public static final int MOD_CONTROL = 2;
	public static final int MOD_ALT = 4;
	//?} else {
	/*public static final int MOD_SHIFT = com.mojang.blaze3d.platform.InputConstants.MOD_SHIFT;
	public static final int MOD_CONTROL = com.mojang.blaze3d.platform.InputConstants.MOD_CONTROL;
	public static final int MOD_ALT = com.mojang.blaze3d.platform.InputConstants.MOD_ALT;
	*///?}

	private GuiInput() {}

	/** Native handle of the game window. */
	public static long window(Minecraft mc) {
		//? if <1.21.9 {
		return mc.getWindow().getWindow();
		//?} else
		/*return mc.getWindow().handle();*/
	}

	/**
	 * A key press or release as the keyboard callback would deliver it (screen first, then key
	 * bindings). From 1.21.9 {@code keyPress} is private: until 26.1 the press goes through the
	 * window's key callback (which schedules it onto the render thread, so it lands a moment later);
	 * Minecraft ships unobfuscated from 26.1 on, so there it is called by its stable name.
	 */
	public static void key(Minecraft mc, int key, int scancode, int action, int modifiers) {
		//? if <1.21.9 {
		mc.keyboardHandler.keyPress(window(mc), key, scancode, action, modifiers);
		//?} else if <26.1 {
		/*long window = window(mc);
		GLFWKeyCallback callback = GLFW.glfwSetKeyCallback(window, null);
		GLFW.glfwSetKeyCallback(window, callback);
		if (callback != null) callback.invoke(window, key, scancode, action, modifiers);
		*///?} else {
		/*try {
			var keyPress = KeyboardHandler.class.getDeclaredMethod("keyPress", long.class, int.class, KeyEvent.class);
			keyPress.setAccessible(true);
			keyPress.invoke(mc.keyboardHandler, window(mc), action, new KeyEvent(key, scancode, modifiers));
		} catch (ReflectiveOperationException e) {
			throw new IllegalStateException("KeyboardHandler.keyPress is unavailable", e);
		}
		*///?}
	}

	/** One typed character (a code point) for the focused widget of {@code screen}. */
	public static void type(Screen screen, int codePoint) {
		//? if <1.21.9 {
		for (char c : Character.toChars(codePoint)) screen.charTyped(c, 0);
		//?} else if <26.1 {
		/*screen.charTyped(new CharacterEvent(codePoint, 0));
		*///?} else
		/*screen.charTyped(new CharacterEvent(codePoint));*/
	}

	/** A full mouse click (press + release) at scaled GUI coordinates. */
	public static void click(Screen screen, double x, double y, int button) {
		//? if <1.21.9 {
		screen.mouseClicked(x, y, button);
		screen.mouseReleased(x, y, button);
		//?} else {
		/*MouseButtonEvent event = new MouseButtonEvent(x, y, new MouseButtonInfo(button, 0));
		screen.mouseClicked(event, false);
		screen.mouseReleased(event);
		*///?}
	}
}
