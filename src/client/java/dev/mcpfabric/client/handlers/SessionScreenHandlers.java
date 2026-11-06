package dev.mcpfabric.client.handlers;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.mcpfabric.McpFabric;
import dev.mcpfabric.bridge.Json;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.client.ClientEvents;
import dev.mcpfabric.client.ClientMc;
import dev.mcpfabric.handlers.support.Gates;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.DeathScreen;
import net.minecraft.client.gui.screens.DisconnectedScreen;
import net.minecraft.client.gui.screens.GenericMessageScreen;
import net.minecraft.client.gui.screens.LevelLoadingScreen;
import net.minecraft.client.gui.screens.PauseScreen;
import net.minecraft.client.gui.screens.ProgressScreen;
//? if <1.21.9
import net.minecraft.client.gui.screens.ReceivingLevelScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.gui.screens.multiplayer.JoinMultiplayerScreen;
import net.minecraft.client.gui.screens.worldselection.SelectWorldScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.ServerList;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.level.storage.LevelSummary;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Getting the client back into a world after it left one: a restarted or crashed server, a kick, a
 * game restart, or a pause menu opened when the window lost focus.
 * <ul>
 *   <li>{@code screen.get} — which kind of screen is open and whether the player is in a world;</li>
 *   <li>{@code screen.close} — close the open in-world screen (pause menu, chat, container), or
 *       respawn on the death screen;</li>
 *   <li>{@code session.worlds} — saved singleplayer worlds and server list entries, by world id;</li>
 *   <li>{@code session.join} — open a world or connect to a server by world id, by default the one
 *       played last in this game run.</li>
 * </ul>
 * Servers are named only by their opaque {@code mp:} id, as in {@code session.info}: the address and
 * the server list entry's name stay in the game, and only servers the player already has in the list
 * (or played in this run) can be joined.
 */
public final class SessionScreenHandlers {
	private SessionScreenHandlers() {}

	private static final long WORLD_LIST_TIMEOUT_MS = 10_000;

	// Render thread only: written by the client tick, read inside ClientMc.call.
	private static boolean wasInWorld;
	private static String lastWorldId;
	/** The server joined last, kept so a server that is not in the server list can be rejoined too. */
	private static ServerData lastServer;

	public static void register(RpcRouter router) {
		router.register("screen.get", ctx -> ClientMc.call(() -> {
			Gates.playerControl();
			Minecraft mc = ClientMc.mc();
			Screen screen = ContainerHandlers.currentScreen();
			JsonObject o = new JsonObject();
			o.addProperty("inWorld", mc.level != null && mc.player != null);
			o.addProperty("screen", kind(screen));
			if (screen != null && "other".equals(kind(screen))) o.addProperty("title", screen.getTitle().getString());
			o.addProperty("paused", mc.isPaused());
			o.addProperty("canJoin", canJoin(mc, screen));
			if (lastWorldId != null) o.addProperty("lastWorldId", lastWorldId);
			return o;
		}));

		router.register("screen.close", ctx -> ClientMc.call(() -> {
			Gates.playerControl();
			Minecraft mc = ClientMc.mc();
			LocalPlayer p = mc.player;
			if (mc.level == null || p == null) {
				throw new RpcException("not_in_world", "Not in a world, so there is no in-world screen to close: use join_world.");
			}
			Screen screen = ContainerHandlers.currentScreen();
			String kind = kind(screen);
			switch (kind) {
				case "none":
					return Json.ok("no screen open");
				case "death":
					p.respawn();
					return Json.ok("respawning");
				case "container":
					p.closeContainer();
					return Json.ok("closed container");
				case "loading":
				case "connecting":
					throw new RpcException("busy", "The game is loading; wait and check get_screen again.");
				default:
					setScreen(mc, null);
					return Json.ok("closed " + kind);
			}
		}));

		router.register("session.worlds", ctx -> {
			Gates.playerControl();
			List<LevelSummary> levels = levelSummaries();
			JsonObject o = new JsonObject();
			JsonArray servers = ClientMc.call(() -> {
				JsonArray ids = new JsonArray();
				Set<String> seen = new HashSet<>();
				ServerList list = new ServerList(ClientMc.mc());
				list.load();
				for (int i = 0; i < list.size(); i++) {
					String id = PerceptionHandlers.multiplayerId(list.get(i));
					if (seen.add(id)) ids.add(id);
				}
				if (lastWorldId != null) o.addProperty("lastWorldId", lastWorldId);
				return ids;
			});
			JsonArray worlds = new JsonArray();
			levels.sort(Comparator.comparingLong(LevelSummary::getLastPlayed).reversed());
			for (LevelSummary level : levels) {
				JsonObject w = new JsonObject();
				w.addProperty("worldId", "sp:" + level.getLevelId());
				w.addProperty("name", level.getLevelName());
				w.addProperty("lastPlayed", level.getLastPlayed());
				w.addProperty("joinable", joinable(level));
				worlds.add(w);
			}
			o.add("singleplayer", worlds);
			o.add("multiplayer", servers);
			return o;
		});

		router.register("session.join", ctx -> {
			Gates.playerControl();
			String requested = ctx.optString("worldId", null);
			if (requested != null && requested.startsWith("sp:")) {
				String levelId = requested.substring(3);
				LevelSummary level = levelSummaries().stream()
						.filter(l -> l.getLevelId().equals(levelId))
						.findFirst()
						.orElseThrow(() -> RpcException.notFound("No saved world with id " + requested + "; see list_worlds."));
				if (!joinable(level)) {
					throw new RpcException("not_joinable", "World " + requested
							+ " cannot be opened from here (open in another game, from an incompatible version, or needs conversion).");
				}
			}
			return ClientMc.call(() -> {
				Minecraft mc = ClientMc.mc();
				if (mc.level != null) {
					throw new RpcException("in_world", "Already in a world; join_world only works from the menus.");
				}
				if (!canJoin(mc, ContainerHandlers.currentScreen())) {
					throw new RpcException("busy", "The game is already connecting or loading; check get_screen.");
				}
				String worldId = requested != null ? requested : lastWorldId;
				if (worldId == null) {
					throw RpcException.badRequest("No world was played in this game run: pass a worldId from list_worlds.");
				}
				if (worldId.startsWith("sp:")) {
					mc.createWorldOpenFlows().openWorld(worldId.substring(3), () -> setScreen(mc, new TitleScreen()));
				} else if (worldId.startsWith("mp:")) {
					ServerData server = findServer(mc, worldId);
					ConnectScreen.startConnecting(new JoinMultiplayerScreen(new TitleScreen()), mc,
							ServerAddress.parseString(server.ip), server, false, null);
				} else {
					throw RpcException.badRequest("worldId must start with sp: or mp: (see list_worlds).");
				}
				JsonObject o = new JsonObject();
				o.addProperty("joining", worldId);
				o.addProperty("note", "Joining runs in the background: poll get_screen until inWorld is true.");
				return o;
			});
		});
	}

	/** End of every client tick: remember the world the player entered last. */
	public static void onClientTick(Minecraft mc) {
		boolean inWorld = mc.level != null;
		if (inWorld && !wasInWorld) {
			lastWorldId = PerceptionHandlers.worldId(mc);
			lastServer = mc.getSingleplayerServer() == null ? mc.getCurrentServer() : null;
		} else if (!inWorld && wasInWorld) {
			// A kick or a lost connection opens the disconnected screen in the same tick.
			ClientEvents.onLeftWorld(kind(ContainerHandlers.currentScreen()));
		}
		wasInWorld = inWorld;
	}

	private static ServerData findServer(Minecraft mc, String worldId) throws RpcException {
		if (worldId.equals(lastWorldId) && lastServer != null) return lastServer;
		ServerList list = new ServerList(mc);
		list.load();
		for (int i = 0; i < list.size(); i++) {
			ServerData data = list.get(i);
			if (PerceptionHandlers.multiplayerId(data).equals(worldId)) return data;
		}
		throw RpcException.notFound("No server in the server list has id " + worldId + "; see list_worlds.");
	}

	/** Saved singleplayer worlds. The list is read on the render thread; the summaries load in the background. */
	static List<LevelSummary> levelSummaries() throws RpcException {
		CompletableFuture<List<LevelSummary>> future = ClientMc.call(() -> {
			Minecraft mc = ClientMc.mc();
			try {
				return mc.getLevelSource().loadLevelSummaries(mc.getLevelSource().findLevelCandidates());
			} catch (Exception e) {
				throw new RpcException("internal", "Could not list the saved worlds: " + e.getMessage());
			}
		});
		try {
			return new ArrayList<>(future.get(WORLD_LIST_TIMEOUT_MS, TimeUnit.MILLISECONDS));
		} catch (TimeoutException e) {
			throw new RpcException("timeout", "Listing the saved worlds took longer than " + WORLD_LIST_TIMEOUT_MS + "ms.");
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			throw new RpcException("interrupted", "Interrupted while listing the saved worlds.");
		} catch (ExecutionException e) {
			McpFabric.LOGGER.warn("[mcpfabric] could not list the saved worlds", e.getCause());
			throw new RpcException("internal", "Could not list the saved worlds.");
		}
	}

	static boolean joinable(LevelSummary level) {
		return !level.isLocked() && !level.isDisabled() && !level.requiresManualConversion() && level.isCompatible();
	}

	/** From the menus, and not while a connection or a world is already loading. */
	static boolean canJoin(Minecraft mc, Screen screen) {
		if (mc.level != null) return false;
		String kind = kind(screen);
		return !kind.equals("connecting") && !kind.equals("loading");
	}

	/** A coarse, version-independent name for the open screen ({@code none} when there is none). */
	static String kind(Screen screen) {
		if (screen == null) return "none";
		if (screen instanceof PauseScreen) return "pause";
		if (screen instanceof DeathScreen) return "death";
		if (screen instanceof ChatScreen) return "chat";
		if (screen instanceof AbstractContainerScreen<?>) return "container";
		if (screen instanceof TitleScreen) return "title";
		if (screen instanceof JoinMultiplayerScreen) return "multiplayer";
		if (screen instanceof SelectWorldScreen) return "singleplayer";
		if (screen instanceof DisconnectedScreen) return "disconnected";
		if (screen instanceof ConnectScreen) return "connecting";
		if (screen instanceof LevelLoadingScreen || screen instanceof ProgressScreen
				|| screen instanceof GenericMessageScreen) return "loading";
		// The dimension change screen; 1.21.9 folded it into LevelLoadingScreen.
		//? if <1.21.9
		if (screen instanceof ReceivingLevelScreen) return "loading";
		return "other";
	}

	/** {@code Minecraft.setScreen} moved to {@code Gui.setScreen} in 26.2. */
	static void setScreen(Minecraft mc, Screen screen) {
		//? if <26.2 {
		mc.setScreen(screen);
		//?} else
		/*mc.gui.setScreen(screen);*/
	}
}
