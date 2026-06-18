package dev.mcpfabric;

import net.minecraft.server.MinecraftServer;
import org.jetbrains.annotations.Nullable;

/**
 * Holds a reference to the currently running {@link MinecraftServer}, whether it is a dedicated
 * server or the integrated server backing a single-player client. Updated from Fabric server
 * lifecycle events in {@link McpFabric}.
 */
public final class ServerHolder {
	private static volatile MinecraftServer server;

	private ServerHolder() {}

	public static void set(@Nullable MinecraftServer s) {
		server = s;
	}

	@Nullable
	public static MinecraftServer get() {
		return server;
	}

	public static boolean isPresent() {
		return server != null;
	}
}
