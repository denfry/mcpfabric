package dev.mcpfabric.client;

import dev.mcpfabric.McpFabric;
import dev.mcpfabric.bridge.MainThread;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.bridge.ThrowingSupplier;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.multiplayer.MultiPlayerGameMode;
import net.minecraft.client.player.LocalPlayer;

/** Null-safe access to client singletons + scheduling onto the render thread. */
public final class ClientMc {
	private ClientMc() {}

	public static Minecraft mc() {
		return Minecraft.getInstance();
	}

	public static LocalPlayer player() throws RpcException {
		LocalPlayer p = mc().player;
		if (p == null) throw RpcException.noClientPlayer();
		return p;
	}

	public static ClientLevel level() throws RpcException {
		ClientLevel l = mc().level;
		if (l == null) throw RpcException.noClientPlayer();
		return l;
	}

	public static MultiPlayerGameMode gameMode() throws RpcException {
		MultiPlayerGameMode g = mc().gameMode;
		if (g == null) throw RpcException.noClientPlayer();
		return g;
	}

	/** Run a task on the render thread and wait for the result. */
	public static <T> T call(ThrowingSupplier<T> task) throws RpcException {
		return MainThread.call(mc(), McpFabric.config().callTimeoutMs, task);
	}
}
