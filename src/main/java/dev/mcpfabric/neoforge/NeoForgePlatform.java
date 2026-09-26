package dev.mcpfabric.neoforge;

import dev.mcpfabric.platform.BlockInventory;
import dev.mcpfabric.platform.Platform;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.item.ItemStack;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.ModList;
import net.neoforged.fml.loading.FMLPaths;
import net.neoforged.neoforge.capabilities.Capabilities;
//? if >=1.21.9 {
/*import net.neoforged.neoforge.transfer.ResourceHandler;
import net.neoforged.neoforge.transfer.ResourceHandlerUtil;
import net.neoforged.neoforge.transfer.item.ItemResource;
import net.neoforged.neoforge.transfer.transaction.Transaction;
*///?} else {
import net.neoforged.neoforge.items.IItemHandler;
import net.neoforged.neoforge.items.ItemHandlerHelper;
//?}
import org.jetbrains.annotations.Nullable;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

final class NeoForgePlatform implements Platform {
	private final String modVersion;
	private final boolean client;

	// The Dist comes from FML's @Mod constructor injection: stable across FML versions, unlike
	// FMLEnvironment (a field before FML 10, a method after).
	NeoForgePlatform(ModContainer container, Dist dist) {
		this.modVersion = container.getModInfo().getVersion().toString();
		this.client = dist.isClient();
	}

	@Override
	public String loader() {
		return "neoforge";
	}

	@Override
	public Path configDir() {
		return FMLPaths.CONFIGDIR.get();
	}

	@Override
	public boolean isClient() {
		return client;
	}

	@Override
	public String minecraftVersion() {
		return ModList.get().getModContainerById("minecraft")
				.map(c -> c.getModInfo().getVersion().toString())
				.orElse("unknown");
	}

	@Override
	public String modVersion() {
		return modVersion;
	}

	/**
	 * NeoForge 21.9 replaced {@code IItemHandler} ({@code Capabilities.ItemHandler.BLOCK}) with the
	 * transactional transfer API ({@code Capabilities.Item.BLOCK}, a {@code ResourceHandler<ItemResource>}).
	 */
	@Override
	@Nullable
	public BlockInventory blockInventory(ServerLevel level, BlockPos pos, @Nullable Direction side) {
		//? if >=1.21.9 {
		/*ResourceHandler<ItemResource> handler = level.getCapability(Capabilities.Item.BLOCK, pos, side);
		if (handler == null) return null;
		return new BlockInventory() {
			@Override
			public List<ItemStack> slots() {
				List<ItemStack> out = new ArrayList<>();
				for (int i = 0; i < handler.size(); i++) {
					ItemResource r = handler.getResource(i);
					out.add(r.isEmpty() ? ItemStack.EMPTY : r.toStack(handler.getAmountAsInt(i)));
				}
				return out;
			}

			@Override
			public int insert(ItemStack stack, boolean simulate) {
				try (Transaction tx = Transaction.open(null)) { // null parent = a root transaction
					int inserted = ResourceHandlerUtil.insertStacking(handler, ItemResource.of(stack), stack.getCount(), tx);
					if (!simulate) tx.commit();
					return inserted;
				}
			}
		};
		*///?} else {
		IItemHandler handler = level.getCapability(Capabilities.ItemHandler.BLOCK, pos, side);
		if (handler == null) return null;
		return new BlockInventory() {
			@Override
			public List<ItemStack> slots() {
				List<ItemStack> out = new ArrayList<>();
				for (int i = 0; i < handler.getSlots(); i++) out.add(handler.getStackInSlot(i).copy());
				return out;
			}

			@Override
			public int insert(ItemStack stack, boolean simulate) {
				ItemStack rest = ItemHandlerHelper.insertItemStacked(handler, stack.copy(), simulate);
				return stack.getCount() - rest.getCount();
			}
		};
		//?}
	}
}
