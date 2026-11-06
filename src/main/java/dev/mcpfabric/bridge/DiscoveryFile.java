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
 * runs from. It is a local file readable only by this user, like the config file the token comes
 * from; nothing about it goes over the bridge. The game that wrote it removes it when it stops.
 * {@code writeDiscoveryFile: false} turns it off.
 */
public final class DiscoveryFile {
	private DiscoveryFile() {}

	public static Path path() {
		return Path.of(System.getProperty("user.home"), ".mcpfabric", "bridge.json");
	}

	public static void write(McpConfig config) {
		if (!config.writeDiscoveryFile) return;
		Path file = path();
		try {
			Files.createDirectories(file.getParent());
			JsonObject o = new JsonObject();
			String host = "0.0.0.0".equals(config.host) || "::".equals(config.host) ? "127.0.0.1" : config.host;
			if (host.indexOf(':') >= 0 && !host.startsWith("[")) host = "[" + host + "]";
			o.addProperty("url", "http://" + host + ":" + config.port);
			if (config.requireAuth) o.addProperty("token", config.token);
			o.addProperty("pid", ProcessHandle.current().pid());
			o.addProperty("side", McpFabric.platform().isClient() ? "client" : "dedicated_server");
			o.addProperty("loader", McpFabric.platform().loader());
			o.addProperty("minecraftVersion", McpFabric.platform().minecraftVersion());
			Path tmp = file.resolveSibling("bridge.json." + ProcessHandle.current().pid() + ".tmp");
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

	/** Removes the file if this process wrote it; another game may have written it since. */
	public static void remove() {
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
