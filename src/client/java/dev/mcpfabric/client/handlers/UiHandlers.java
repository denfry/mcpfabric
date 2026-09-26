package dev.mcpfabric.client.handlers;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.mcpfabric.McpFabric;
import dev.mcpfabric.bridge.Json;
import dev.mcpfabric.bridge.RpcContext;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.client.ClientCompat;
import dev.mcpfabric.client.ClientMc;
import dev.mcpfabric.client.ClientTasks;
import dev.mcpfabric.client.GuiInput;
import dev.mcpfabric.handlers.support.Levels;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractButton;
import net.minecraft.client.gui.components.AbstractSelectionList;
import net.minecraft.client.gui.components.AbstractSliderButton;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Checkbox;
import net.minecraft.client.gui.components.CycleButton;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.components.MultiLineEditBox;
import net.minecraft.client.gui.components.TabButton;
import net.minecraft.client.gui.components.events.ContainerEventHandler;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.Slot;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Screens and raw input: read the open screen (widgets, container slots), click widgets and slots,
 * type into text fields, press keys, close the screen. Everything goes through the same entry points
 * real input uses, so modded screens behave as they do for a player.
 */
public final class UiHandlers {
	private UiHandlers() {}

	/** A widget found on the screen, with the chain of containers leading to it (for focusing). */
	private record Found(AbstractWidget widget, List<ContainerEventHandler> path) {}

	public static void register(RpcRouter router) {
		router.register("ui.getScreen", ctx -> ClientMc.call(() -> {
			Minecraft mc = ClientMc.mc();
			Screen screen = ClientCompat.screen(mc);
			JsonObject o = new JsonObject();
			o.addProperty("inWorld", mc.level != null);
			if (screen == null) {
				o.add("screen", null);
				return o;
			}
			JsonObject s = new JsonObject();
			s.addProperty("class", screen.getClass().getName());
			s.addProperty("title", screen.getTitle().getString());
			s.addProperty("width", screen.width);
			s.addProperty("height", screen.height);
			s.addProperty("closesOnEsc", screen.shouldCloseOnEsc());
			s.addProperty("pausesGame", screen.isPauseScreen());

			JsonArray widgets = new JsonArray();
			List<Found> found = widgets(screen);
			for (int i = 0; i < found.size(); i++) widgets.add(describe(i, found.get(i)));
			s.add("widgets", widgets);

			if (screen instanceof AbstractContainerScreen<?> container) {
				AbstractContainerMenu menu = container.getMenu();
				s.addProperty("containerId", menu.containerId);
				JsonArray slots = new JsonArray();
				for (int i = 0; i < menu.slots.size(); i++) {
					Slot slot = menu.slots.get(i);
					JsonObject j = Levels.itemJson(slot.getItem());
					j.addProperty("index", i);
					j.addProperty("x", slot.x);
					j.addProperty("y", slot.y);
					j.addProperty("playerInventory", slot.container == mc.player.getInventory());
					j.addProperty("containerSlot", slot.getContainerSlot());
					if (!slot.isActive()) j.addProperty("active", false);
					slots.add(j);
				}
				s.add("slots", slots);
				s.add("carried", Levels.itemJson(menu.getCarried()));
			}
			o.add("screen", s);
			return o;
		}));

		router.register("ui.closeScreen", ctx -> ClientMc.call(() -> {
			requireControl();
			Minecraft mc = ClientMc.mc();
			Screen screen = ClientCompat.screen(mc);
			if (screen == null) return Json.ok("no screen open");
			boolean force = ctx.optBool("force", false);
			String name = screen.getClass().getName();
			if (force) {
				// Closing a container through the player also tells the server (drops the cursor stack
				// back, releases the block entity); any other screen is simply replaced.
				if (screen instanceof AbstractContainerScreen<?> && mc.player != null) {
					mc.player.closeContainer();
				}
				if (ClientCompat.screen(mc) == screen) ClientCompat.setScreen(mc, null);
			} else {
				if (!screen.shouldCloseOnEsc()) {
					throw RpcException.badRequest("This screen (" + name + ") ignores Esc; pass force: true to close it anyway.");
				}
				screen.onClose();
			}
			JsonObject o = Json.ok("closed " + name);
			o.addProperty("screenNow", ClientCompat.screenName(mc));
			return o;
		}));

		router.register("ui.clickWidget", ctx -> ClientMc.call(() -> {
			requireControl();
			Screen screen = requireScreen();
			Found f = findWidget(screen, ctx);
			AbstractWidget w = f.widget();
			double x = w.getX() + w.getWidth() / 2.0;
			double y = w.getY() + w.getHeight() / 2.0;
			GuiInput.click(screen, x, y, ctx.optInt("button", 0));
			JsonObject o = Json.ok("clicked " + label(w));
			o.addProperty("active", w.active);
			o.addProperty("screenNow", ClientCompat.screenName(ClientMc.mc()));
			return o;
		}));

		// Screens that draw their own tabs and rows have no widgets to find; a click at a point in the
		// screen's own (GUI-scaled) coordinates is what a mouse would do there.
		router.register("ui.clickAt", ctx -> ClientMc.call(() -> {
			requireControl();
			Screen screen = requireScreen();
			double x = ctx.getDouble("x");
			double y = ctx.getDouble("y");
			GuiInput.click(screen, x, y, ctx.optInt("button", 0));
			JsonObject o = Json.ok("clicked at " + x + ", " + y);
			o.addProperty("screenNow", ClientCompat.screenName(ClientMc.mc()));
			return o;
		}));

		router.register("ui.focus", ctx -> ClientMc.call(() -> {
			requireControl();
			Screen screen = requireScreen();
			Found f = findWidget(screen, ctx);
			// Focus every container on the way down, so the widget is the end of the focus path.
			List<ContainerEventHandler> path = f.path();
			for (int i = 0; i < path.size(); i++) {
				GuiEventListener child = i + 1 < path.size() ? path.get(i + 1) : f.widget();
				path.get(i).setFocused(child);
			}
			return Json.ok("focused " + label(f.widget()));
		}));

		router.register("ui.typeText", ctx -> ClientMc.call(() -> {
			requireControl();
			Minecraft mc = ClientMc.mc();
			Screen screen = requireScreen();
			String text = ctx.getString("text");
			text.codePoints().forEach(cp -> GuiInput.type(screen, cp));
			if (ctx.optBool("enter", false)) tap(mc, InputConstants.getKey("key.keyboard.enter").getValue(), 0);
			JsonObject o = Json.ok("typed " + text.codePointCount(0, text.length()) + " characters");
			GuiEventListener focused = focusedLeaf(screen);
			if (focused instanceof EditBox box) o.addProperty("value", box.getValue());
			else if (focused instanceof MultiLineEditBox box) o.addProperty("value", box.getValue());
			else if (focused == null) o.addProperty("warning", "No widget has focus; use focus_widget first.");
			return o;
		}));

		router.register("ui.clickSlot", ctx -> ClientMc.call(() -> {
			requireControl();
			Screen screen = requireScreen();
			if (!(screen instanceof AbstractContainerScreen<?> container)) {
				throw RpcException.badRequest("The open screen is not a container screen.");
			}
			AbstractContainerMenu menu = container.getMenu();
			int slot = ctx.getInt("slot");
			if (slot != -999 && (slot < 0 || slot >= menu.slots.size())) {
				throw RpcException.badRequest("Slot out of range (0-" + (menu.slots.size() - 1) + ", or -999 for outside).");
			}
			LocalPlayer p = ClientMc.player();
			int button = ctx.optInt("button", 0);
			InventoryHandlers.click(ClientMc.gameMode(), menu.containerId, slot, button,
					ctx.optBool("shift", false) ? InventoryHandlers.Click.QUICK_MOVE : InventoryHandlers.Click.PICKUP, p);
			JsonObject o = new JsonObject();
			if (slot >= 0) o.add("slot", Levels.itemJson(menu.slots.get(slot).getItem()));
			o.add("carried", Levels.itemJson(menu.getCarried()));
			return o;
		}));

		router.register("input.pressKey", ctx -> ClientMc.call(() -> {
			requireControl();
			Minecraft mc = ClientMc.mc();
			String name = ctx.getString("key");
			InputConstants.Key key = resolveKey(mc, name);
			int mods = modifiers(ctx);
			int holdTicks = Math.max(0, ctx.optInt("holdTicks", 0));
			int code = key.getValue();
			int scancode = 0; // only consulted for keys without a key code
			GuiInput.key(mc, code, scancode, GuiInput.PRESS, mods);
			if (holdTicks == 0) {
				GuiInput.key(mc, code, scancode, GuiInput.RELEASE, mods);
			} else {
				ClientTasks.later(holdTicks, () -> GuiInput.key(mc, code, scancode, GuiInput.RELEASE, mods));
			}
			JsonObject o = Json.ok("pressed " + key.getName());
			o.addProperty("holdTicks", holdTicks);
			o.addProperty("screenNow", ClientCompat.screenName(mc));
			return o;
		}));
	}

	// --- widgets -------------------------------------------------------------------------------

	/** Every widget on the screen, depth first, descending into containers (lists, tabs, panels). */
	private static List<Found> widgets(Screen screen) {
		List<Found> out = new ArrayList<>();
		collect(screen, new ArrayList<>(List.of(screen)), out);
		return out;
	}

	/** Every widget on the screen, depth first (the order {@code ui.getScreen} indexes them in). */
	static List<AbstractWidget> widgetList(Screen screen) {
		List<AbstractWidget> out = new ArrayList<>();
		for (Found f : widgets(screen)) out.add(f.widget());
		return out;
	}

	private static void collect(ContainerEventHandler parent, List<ContainerEventHandler> path, List<Found> out) {
		for (GuiEventListener child : List.copyOf(parent.children())) {
			if (child instanceof AbstractWidget w) out.add(new Found(w, List.copyOf(path)));
			if (child instanceof ContainerEventHandler c && path.size() < 8) {
				path.add(c);
				collect(c, path, out);
				path.remove(path.size() - 1);
			}
		}
	}

	private static JsonObject describe(int index, Found f) {
		AbstractWidget w = f.widget();
		JsonObject o = new JsonObject();
		o.addProperty("index", index);
		o.addProperty("type", type(w));
		o.addProperty("label", label(w));
		o.addProperty("x", w.getX());
		o.addProperty("y", w.getY());
		o.addProperty("width", w.getWidth());
		o.addProperty("height", w.getHeight());
		o.addProperty("active", w.active);
		o.addProperty("visible", w.visible);
		o.addProperty("focused", w.isFocused());
		if (w instanceof EditBox box) o.addProperty("value", box.getValue());
		if (w instanceof MultiLineEditBox box) o.addProperty("value", box.getValue());
		if (w instanceof Checkbox box) o.addProperty("selected", box.selected());
		o.addProperty("class", w.getClass().getName());
		return o;
	}

	/** A loader-independent widget kind (class names are obfuscated on Fabric). */
	private static String type(AbstractWidget w) {
		if (w instanceof EditBox || w instanceof MultiLineEditBox) return "text_field";
		if (w instanceof Checkbox) return "checkbox";
		if (w instanceof CycleButton<?>) return "cycle_button";
		if (w instanceof TabButton) return "tab";
		if (w instanceof AbstractSliderButton) return "slider";
		if (w instanceof AbstractButton) return "button";
		if (w instanceof AbstractSelectionList<?>) return "list";
		return "widget";
	}

	private static String label(AbstractWidget w) {
		return w.getMessage().getString();
	}

	/** The widget named by {@code index} or {@code label} (exact first, then case-insensitive substring). */
	private static Found findWidget(Screen screen, RpcContext ctx) throws RpcException {
		List<Found> all = widgets(screen);
		if (ctx.has("index")) {
			int i = ctx.getInt("index");
			if (i < 0 || i >= all.size()) throw RpcException.badRequest("Widget index out of range (0-" + (all.size() - 1) + ").");
			return all.get(i);
		}
		if (!ctx.has("label")) throw RpcException.badRequest("Provide 'index' or 'label'.");
		String wanted = ctx.getString("label");
		for (Found f : all) {
			if (f.widget().visible && label(f.widget()).equals(wanted)) return f;
		}
		String lower = wanted.toLowerCase(Locale.ROOT);
		for (Found f : all) {
			if (f.widget().visible && label(f.widget()).toLowerCase(Locale.ROOT).contains(lower)) return f;
		}
		JsonArray labels = new JsonArray();
		for (Found f : all) if (f.widget().visible) labels.add(label(f.widget()));
		JsonObject data = new JsonObject();
		data.add("labels", labels);
		throw new RpcException("not_found", "No visible widget labelled '" + wanted + "'.", data);
	}

	/** The innermost focused listener of the screen's focus path, or null. */
	private static GuiEventListener focusedLeaf(Screen screen) {
		GuiEventListener f = screen.getFocused();
		while (f instanceof ContainerEventHandler c && c.getFocused() != null) f = c.getFocused();
		return f;
	}

	// --- keys ----------------------------------------------------------------------------------

	/**
	 * A key by name ("escape", "e", "f3", "left.shift", "key.keyboard.enter") or by key-binding
	 * name ("key.inventory"), which resolves to whatever key it is currently bound to.
	 */
	private static InputConstants.Key resolveKey(Minecraft mc, String name) throws RpcException {
		String n = name.trim().toLowerCase(Locale.ROOT);
		for (KeyMapping mapping : mc.options.keyMappings) {
			if (mapping.getName().equals(name)) {
				InputConstants.Key bound = InputConstants.getKey(mapping.saveString());
				if (bound.getType() == InputConstants.Type.MOUSE) {
					throw RpcException.badRequest(name + " is bound to " + bound.getName() + ", not a keyboard key.");
				}
				return bound;
			}
		}
		n = switch (n) {
			case "esc" -> "escape";
			case "return" -> "enter";
			case "shift" -> "left.shift";
			case "ctrl", "control" -> "left.control";
			case "alt" -> "left.alt";
			case "del" -> "delete";
			case "pageup" -> "page.up";
			case "pagedown" -> "page.down";
			default -> n;
		};
		if (!n.startsWith("key.")) n = "key.keyboard." + n;
		try {
			InputConstants.Key key = InputConstants.getKey(n);
			if (key.getType() != InputConstants.Type.MOUSE && key.getValue() != InputConstants.UNKNOWN.getValue()) return key;
		} catch (RuntimeException ignored) {
			// unknown name
		}
		throw RpcException.badRequest("Unknown key '" + name + "'. Use key names like escape, enter, tab, e, f3, 1, left.shift, or a key binding like key.inventory.");
	}

	private static int modifiers(RpcContext ctx) throws RpcException {
		int mods = 0;
		for (String m : ctx.getStringList("modifiers")) {
			mods |= switch (m.toLowerCase(Locale.ROOT)) {
				case "shift" -> GuiInput.MOD_SHIFT;
				case "ctrl", "control" -> GuiInput.MOD_CONTROL;
				case "alt" -> GuiInput.MOD_ALT;
				default -> throw RpcException.badRequest("Unknown modifier '" + m + "' (shift, ctrl, alt).");
			};
		}
		return mods;
	}

	/** Press and release a key at once. */
	static void tap(Minecraft mc, int key, int mods) {
		GuiInput.key(mc, key, 0, GuiInput.PRESS, mods);
		GuiInput.key(mc, key, 0, GuiInput.RELEASE, mods);
	}

	// --- helpers -------------------------------------------------------------------------------

	private static Screen requireScreen() throws RpcException {
		Screen s = ClientCompat.screen(ClientMc.mc());
		if (s == null) throw new RpcException("no_screen", "No screen is open.");
		return s;
	}

	private static void requireControl() throws RpcException {
		if (!McpFabric.config().enablePlayerControl) {
			throw RpcException.unavailable("Player control is disabled in mcpfabric.config.json (enablePlayerControl=false).");
		}
	}
}
