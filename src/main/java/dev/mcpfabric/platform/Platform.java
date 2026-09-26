package dev.mcpfabric.platform;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import org.jetbrains.annotations.Nullable;

import java.nio.file.Path;

/**
 * The few mod-loader services the shared code needs. Each loader entrypoint (Fabric, NeoForge)
 * supplies its own implementation to {@link dev.mcpfabric.McpFabric#init(Platform)}; nothing outside
 * the loader packages may touch loader APIs directly.
 */
public interface Platform {
	/** Loader name as reported by {@code info.status} ({@code "fabric"} / {@code "neoforge"}). */
	String loader();

	/** Directory holding {@code mcpfabric.config.json}. */
	Path configDir();

	/** True on the physical client (singleplayer / connected client), false on a dedicated server. */
	boolean isClient();

	String minecraftVersion();

	String modVersion();

	/**
	 * The item inventory the block at {@code pos} exposes through the loader's item-handler
	 * capability, seen from {@code side} ({@code null} = the unsided view), or {@code null} when it
	 * has none. Server thread only.
	 */
	@Nullable
	BlockInventory blockInventory(ServerLevel level, BlockPos pos, @Nullable Direction side);
}
