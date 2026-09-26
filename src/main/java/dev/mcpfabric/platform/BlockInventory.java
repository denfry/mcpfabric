package dev.mcpfabric.platform;

import net.minecraft.world.item.ItemStack;

import java.util.List;

/**
 * A block's item inventory as the loader exposes it to automation (NeoForge's item-handler
 * capability, Fabric's Transfer API), so modded devices without a vanilla {@code Container} work too.
 */
public interface BlockInventory {
	/** Copies of every slot's stack, in slot order (empty stacks included). */
	List<ItemStack> slots();

	/**
	 * Inserts as much of {@code stack} as fits, like a hopper would, and returns how many items went
	 * in. With {@code simulate} nothing changes.
	 */
	int insert(ItemStack stack, boolean simulate);
}
