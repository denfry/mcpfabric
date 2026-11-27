package dev.mcpfabric.bridge;

import com.google.gson.JsonObject;
import dev.mcpfabric.McpFabric;
import dev.mcpfabric.config.McpConfig;

import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;

/**
 * {@code ~/.mcpfabric/bridge.json}: where the running bridge listens and its token, so the MCP server
 * connects without anyone copying the token by hand, whatever launcher or instance folder the game
 * runs from. Each game also writes {@code ~/.mcpfabric/bridges/<pid>.json} with a name, so with
 * several games running an MCP server picks one by MCPFABRIC_INSTANCE. It is a local file readable only by this user, like the config file the token comes
 * from; nothing about it goes over the bridge. The game that wrote it removes it when it stops.
 * {@code writeDiscoveryFile: false} turns it off.
 */
public final class DiscoveryFile {
	private static McpConfig config;
	private static int port;
	private static String player = "";

	private DiscoveryFile() {}

	/** The newest game's file, as before several games could run: an MCP server without MCPFABRIC_INSTANCE reads it. */
	public static Path path() {
		return Path.of(System.getProperty("user.home"), ".mcpfabric", "bridge.json");
	}

	/** This game's own file in {@code ~/.mcpfabric/bridges/}, named by process id. */
	public static Path instancePath() {
		return path().resolveSibling("bridges").resolve(ProcessHandle.current().pid() + ".json");
	}

	public static void write(McpConfig cfg, int boundPort) {
		config = cfg;
		port = boundPort;
		if (!cfg.writeDiscoveryFile) return;
		writeFile(path());
		writeFile(instancePath());
	}

	/**
	 * The client's account name, once known: it names this game in its own file when
	 * {@code instanceName} is empty. Only the instance file is written again.
	 */
	public static void setPlayer(String name) {
		String n = name == null ? "" : name;
		if (n.equals(player)) return;
		player = n;
		if (config != null && config.writeDiscoveryFile) writeFile(instancePath());
	}

	/** The name this game answers to: the configured one, else the account name, else the game folder's name. */
	static String name(String configured, String account, Path gameDir) {
		if (configured != null && !configured.isBlank()) return configured.strip();
		if (account != null && !account.isBlank()) return account;
		Path f = gameDir == null ? null : gameDir.getFileName();
		return f == null ? "" : f.toString();
	}

	private static void writeFile(Path file) {
		try {
			Files.createDirectories(file.getParent());
			JsonObject o = new JsonObject();
			String host = "0.0.0.0".equals(config.host) || "::".equals(config.host) ? "127.0.0.1" : config.host;
			if (host.indexOf(':') >= 0 && !host.startsWith("[")) host = "[" + host + "]";
			o.addProperty("url", "http://" + host + ":" + port);
			if (config.requireAuth) o.addProperty("token", config.token);
			o.addProperty("pid", ProcessHandle.current().pid());
			o.addProperty("side", McpFabric.platform().isClient() ? "client" : "dedicated_server");
			o.addProperty("loader", McpFabric.platform().loader());
			o.addProperty("minecraftVersion", McpFabric.platform().minecraftVersion());
			Path gameDir = McpFabric.platform().configDir().toAbsolutePath().normalize().getParent();
			o.addProperty("name", name(config.instanceName, player, gameDir));
			if (!player.isEmpty()) o.addProperty("player", player);
			if (gameDir != null && gameDir.getFileName() != null) o.addProperty("gameDir", gameDir.getFileName().toString());
			Path tmp = file.resolveSibling(file.getFileName() + "." + ProcessHandle.current().pid() + ".tmp");
			Files.writeString(tmp, o.toString());
			ownerOnly(tmp);
			try {
				Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
			} catch (AtomicMoveNotSupportedException e) {
				Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
			}
		} catch (IOException | RuntimeException e) {
			McpFabric.LOGGER.warn("[mcpfabric] could not write {}: {}", file, e.toString());
		}
	}

	/** Removes this game's file, and the shared one if this process wrote it last. */
	public static void remove() {
		try {
			Files.deleteIfExists(instancePath());
		} catch (IOException | RuntimeException e) {
			McpFabric.LOGGER.debug("[mcpfabric] could not remove {}: {}", instancePath(), e.toString());
		}
		Path file = path();
		try {
			if (!Files.exists(file)) return;
			JsonObject o = Json.GSON.fromJson(Files.readString(file), JsonObject.class);
			if (o != null && o.has("pid") && o.get("pid").getAsLong() == ProcessHandle.current().pid()) Files.deleteIfExists(file);
		} catch (IOException | RuntimeException e) {
			McpFabric.LOGGER.debug("[mcpfabric] could not remove {}: {}", file, e.toString());
		}
	}

	private static void ownerOnly(Path file) throws IOException {
		try {
			Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"));
		} catch (UnsupportedOperationException e) {
			// Windows: the user's profile folder is already private to the user.
		}
	}
}
