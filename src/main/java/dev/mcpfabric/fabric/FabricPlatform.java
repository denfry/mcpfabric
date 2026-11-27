package dev.mcpfabric.fabric;

import dev.mcpfabric.McpFabric;
import dev.mcpfabric.platform.Platform;
import net.fabricmc.api.EnvType;
import net.fabricmc.loader.api.FabricLoader;

import java.nio.file.Path;
import java.util.List;

final class FabricPlatform implements Platform {
	@Override
	public String loader() {
		return "fabric";
	}

	@Override
	public Path configDir() {
		return FabricLoader.getInstance().getConfigDir();
	}

	@Override
	public boolean isClient() {
		return FabricLoader.getInstance().getEnvironmentType() == EnvType.CLIENT;
	}

	@Override
	public String minecraftVersion() {
		return version("minecraft", "unknown");
	}

	@Override
	public String modVersion() {
		return version(McpFabric.MOD_ID, "dev");
	}

	@Override
	public List<ModInfo> mods() {
		return FabricLoader.getInstance().getAllMods().stream()
				.map(c -> new ModInfo(c.getMetadata().getId(), c.getMetadata().getName(), c.getMetadata().getVersion().getFriendlyString()))
				.toList();
	}

	private static String version(String modId, String fallback) {
		return FabricLoader.getInstance()
				.getModContainer(modId)
				.map(c -> c.getMetadata().getVersion().getFriendlyString())
				.orElse(fallback);
	}
}
