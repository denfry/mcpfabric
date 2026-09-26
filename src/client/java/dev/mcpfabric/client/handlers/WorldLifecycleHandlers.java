package dev.mcpfabric.client.handlers;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.mcpfabric.McpFabric;
import dev.mcpfabric.bridge.Json;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.client.ClientCompat;
import dev.mcpfabric.client.ClientMc;
import dev.mcpfabric.client.GuiInput;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.screens.GenericMessageScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.gui.screens.multiplayer.JoinMultiplayerScreen;
import net.minecraft.client.gui.screens.worldselection.CreateWorldScreen;
import net.minecraft.client.gui.screens.worldselection.WorldCreationUiState;
import net.minecraft.core.Holder;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceKey;
//? if <1.21.11 {
import net.minecraft.resources.ResourceLocation;
//?} else
/*import net.minecraft.resources.Identifier;*/
import net.minecraft.world.level.levelgen.presets.WorldPreset;
import net.minecraft.world.level.storage.LevelStorageSource;
import net.minecraft.world.level.storage.LevelSummary;

import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

/**
 * Singleplayer world lifecycle from the title screen: list saves, open one, create one (any world
 * preset in the registry, modded ones included), leave. Loading and saving block the render thread
 * for seconds, longer than an RPC may wait, so those calls validate, schedule the work and return;
 * the caller polls {@code info.status} / {@code ui.getScreen}.
 */
public final class WorldLifecycleHandlers {
	/** How long {@code world.create} waits for the create-world screen (it loads data packs first). */
	private static final long CREATE_SCREEN_TIMEOUT_MS = 30_000;

	private WorldLifecycleHandlers() {}

	public static void register(RpcRouter router) {
		router.register("world.listSaves", ctx -> {
			JsonArray saves = new JsonArray();
			for (LevelSummary s : summaries()) {
				JsonObject o = new JsonObject();
				o.addProperty("id", s.getLevelId());
				o.addProperty("name", s.getLevelName());
				o.addProperty("lastPlayed", s.getLastPlayed());
				o.addProperty("gameMode", s.getSettings().gameType().getName());
				o.addProperty("hardcore", s.isHardcore());
				o.addProperty("cheats", s.hasCommands());
				o.addProperty("locked", s.isLocked());
				o.addProperty("version", s.getWorldVersionName().getString());
				saves.add(o);
			}
			JsonObject o = new JsonObject();
			o.add("saves", saves);
			return o;
		});

		router.register("world.joinSingleplayer", ctx -> {
			requireControl();
			String name = ctx.getString("name");
			String id = null;
			for (LevelSummary s : summaries()) {
				if (s.getLevelId().equals(name)) id = s.getLevelId();
			}
			if (id == null) {
				for (LevelSummary s : summaries()) {
					if (s.getLevelName().equalsIgnoreCase(name)) id = s.getLevelId();
				}
			}
			if (id == null) throw RpcException.notFound("No singleplayer save named '" + name + "' (see world.listSaves).");
			String levelId = id;
			ClientMc.call(() -> {
				requireNoWorld();
				return null;
			});
			// Opening runs the whole load on the render thread: schedule it, do not wait for it.
			Minecraft mc = ClientMc.mc();
			mc.execute(() -> mc.createWorldOpenFlows().openWorld(levelId, () -> ClientCompat.setScreen(mc, new TitleScreen())));
			JsonObject o = Json.ok("opening " + levelId + "; poll get_status until inWorld");
			o.addProperty("id", levelId);
			return o;
		});

		router.register("world.create", ctx -> {
			requireControl();
			String name = ctx.getString("name");
			if (name.isBlank()) throw RpcException.badRequest("name must not be blank.");
			String mode = ctx.optString("gameMode", null);
			WorldCreationUiState.SelectedGameMode gameMode = null;
			if (mode != null) {
				gameMode = switch (mode.toLowerCase(Locale.ROOT)) {
					case "survival" -> WorldCreationUiState.SelectedGameMode.SURVIVAL;
					case "creative" -> WorldCreationUiState.SelectedGameMode.CREATIVE;
					case "hardcore" -> WorldCreationUiState.SelectedGameMode.HARDCORE;
					default -> throw RpcException.badRequest("gameMode must be survival|creative|hardcore.");
				};
			}
			ResourceKey<WorldPreset> presetKey = null;
			if (ctx.has("levelType")) {
				String type = ctx.getString("levelType");
				//? if <1.21.11 {
				ResourceLocation typeId = ResourceLocation.tryParse(type);
				//?} else
				/*Identifier typeId = Identifier.tryParse(type);*/
				if (typeId == null) throw RpcException.badRequest("Invalid levelType: " + type);
				presetKey = ResourceKey.create(Registries.WORLD_PRESET, typeId);
			}

			// The create-world screen loads the data packs (and so every modded world preset) first,
			// then replaces the current screen: open it and wait for it to appear.
			Minecraft mc = ClientMc.mc();
			ClientMc.call(() -> {
				requireNoWorld();
				ClientCompat.openCreateWorld(mc, ClientCompat.screen(mc));
				return null;
			});
			CreateWorldScreen screen = awaitCreateScreen(mc);

			WorldCreationUiState.SelectedGameMode chosenMode = gameMode;
			ResourceKey<WorldPreset> chosenPreset = presetKey;
			JsonObject o = ClientMc.call(() -> {
				WorldCreationUiState ui = screen.getUiState();
				ui.setName(name);
				if (chosenMode != null) ui.setGameMode(chosenMode);
				if (ctx.has("cheats")) ui.setAllowCommands(ctx.optBool("cheats", false));
				if (ctx.has("seed")) ui.setSeed(ctx.getString("seed"));
				if (chosenPreset != null) {
					// Straight from the registry the data packs built, so modded presets work too.
					Optional<? extends Holder<WorldPreset>> preset = ui.getSettings().worldgenLoadContext()
							.lookupOrThrow(Registries.WORLD_PRESET).get(chosenPreset);
					if (preset.isEmpty()) {
						throw RpcException.notFound("No world preset " + ctx.getString("levelType") + " in the registry.");
					}
					ui.setWorldType(new WorldCreationUiState.WorldTypeEntry(preset.get()));
				}
				JsonObject r = Json.ok("creating " + ui.getName() + "; poll get_status until inWorld");
				r.addProperty("folder", ui.getTargetFolder());
				r.addProperty("gameMode", ui.getGameMode().name().toLowerCase(Locale.ROOT));
				r.addProperty("cheats", ui.isAllowCommands());
				r.addProperty("levelType", ui.getWorldType().preset() == null ? null
						: ui.getWorldType().preset().unwrapKey().map(k -> keyId(k)).orElse(null));
				return r;
			});
			// The create button runs the whole world load on the render thread: schedule, do not wait.
			mc.execute(() -> {
				if (ClientCompat.screen(mc) != screen) return;
				String create = Component.translatable("selectWorld.create").getString();
				for (AbstractWidget w : UiHandlers.widgetList(screen)) {
					if (w.visible && w.active && w.getMessage().getString().equals(create)) {
						GuiInput.click(screen, w.getX() + w.getWidth() / 2.0, w.getY() + w.getHeight() / 2.0, 0);
						return;
					}
				}
				McpFabric.LOGGER.warn("[mcpfabric] world.create: no '{}' button on the create-world screen", create);
			});
			return o;
		});

		router.register("world.leave", ctx -> {
			requireControl();
			Minecraft mc = ClientMc.mc();
			boolean local = ClientMc.call(() -> {
				if (mc.level == null) throw new RpcException("not_in_world", "Not in a world.");
				return mc.isLocalServer();
			});
			mc.execute(() -> leave(mc));
			return Json.ok(local ? "saving and quitting to the title screen" : "disconnecting");
		});
	}

	/** Every singleplayer save, newest first. */
	private static List<LevelSummary> summaries() throws RpcException {
		LevelStorageSource source = ClientMc.mc().getLevelSource();
		try {
			return source.loadLevelSummaries(source.findLevelCandidates()).get(15, TimeUnit.SECONDS);
		} catch (Exception e) {
			throw new RpcException("saves_unreadable", "Could not read the saves folder: " + e.getMessage());
		}
	}

	/** What the pause screen's "Save and Quit to Title" / "Disconnect" button does. */
	private static void leave(Minecraft mc) {
		boolean local = mc.isLocalServer();
		//? if >=1.21.6 {
		mc.disconnectWithSavingScreen();
		//?} else {
		/*if (mc.level != null) mc.level.disconnect();
		if (local) {
			mc.disconnect(new GenericMessageScreen(Component.translatable("menu.savingLevel")));
		} else {
			mc.disconnect();
		}
		*///?}
		TitleScreen title = new TitleScreen();
		ClientCompat.setScreen(mc, local ? title : new JoinMultiplayerScreen(title));
	}

	private static CreateWorldScreen awaitCreateScreen(Minecraft mc) throws RpcException {
		long deadline = System.currentTimeMillis() + CREATE_SCREEN_TIMEOUT_MS;
		while (System.currentTimeMillis() < deadline) {
			Screen s = ClientMc.call(() -> ClientCompat.screen(mc));
			if (s instanceof CreateWorldScreen create) return create;
			try {
				Thread.sleep(100);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
				throw new RpcException("interrupted", "Interrupted while waiting for the create-world screen.");
			}
		}
		throw new RpcException("timeout", "The create-world screen did not open (data packs failed to load?); see get_screen.");
	}

	private static String keyId(ResourceKey<?> key) {
		//? if <1.21.11 {
		return key.location().toString();
		//?} else
		/*return key.identifier().toString();*/
	}

	private static void requireNoWorld() throws RpcException {
		if (ClientMc.mc().level != null) {
			throw new RpcException("in_world", "A world is loaded; leave it first (world.leave).");
		}
	}

	private static void requireControl() throws RpcException {
		if (!McpFabric.config().enablePlayerControl) {
			throw RpcException.unavailable("Player control is disabled in mcpfabric.config.json (enablePlayerControl=false).");
		}
	}
}
