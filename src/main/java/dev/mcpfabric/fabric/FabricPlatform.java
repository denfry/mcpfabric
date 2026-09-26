package dev.mcpfabric.fabric;

import dev.mcpfabric.McpFabric;
import dev.mcpfabric.platform.BlockInventory;
import dev.mcpfabric.platform.Platform;
import net.fabricmc.api.EnvType;
import net.fabricmc.fabric.api.transfer.v1.item.ItemStorage;
import net.fabricmc.fabric.api.transfer.v1.item.ItemVariant;
import net.fabricmc.fabric.api.transfer.v1.storage.Storage;
import net.fabricmc.fabric.api.transfer.v1.storage.StorageView;
import net.fabricmc.fabric.api.transfer.v1.transaction.Transaction;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.item.ItemStack;
import org.jetbrains.annotations.Nullable;

import java.nio.file.Path;
import java.util.ArrayList;
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
	@Nullable
	public BlockInventory blockInventory(ServerLevel level, BlockPos pos, @Nullable Direction side) {
		Storage<ItemVariant> storage = ItemStorage.SIDED.find(level, pos, side);
		if (storage == null) return null;
		return new BlockInventory() {
			@Override
			public List<ItemStack> slots() {
				List<ItemStack> out = new ArrayList<>();
				for (StorageView<ItemVariant> view : storage) {
					out.add(view.isResourceBlank() ? ItemStack.EMPTY : view.getResource().toStack((int) view.getAmount()));
				}
				return out;
			}

			@Override
			public int insert(ItemStack stack, boolean simulate) {
				try (Transaction tx = Transaction.openOuter()) {
					long inserted = storage.insert(ItemVariant.of(stack), stack.getCount(), tx);
					if (!simulate) tx.commit();
					return (int) inserted;
				}
			}
		};
	}

	private static String version(String modId, String fallback) {
		return FabricLoader.getInstance()
				.getModContainer(modId)
				.map(c -> c.getMetadata().getVersion().getFriendlyString())
				.orElse(fallback);
	}
}
