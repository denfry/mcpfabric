package dev.mcpfabric.client.nav;

import dev.mcpfabric.nav.NavCell;
import dev.mcpfabric.nav.NavPos;
import dev.mcpfabric.nav.NavWorld;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CampfireBlock;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.shapes.VoxelShape;

import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.Map;
import java.util.Set;

/**
 * The client level as the planner sees it: each cell classified once per search (cached), with
 * break times for the player's hotbar. Read on the game thread only.
 */
public final class LevelNavWorld implements NavWorld {
	/** Cheap blocks the walker may place under itself to pillar up. */
	private static final Set<Item> THROWAWAY = Set.of(Items.COBBLESTONE, Items.COBBLED_DEEPSLATE, Items.DIRT,
			Items.NETHERRACK, Items.ANDESITE, Items.DIORITE, Items.GRANITE, Items.TUFF, Items.BLACKSTONE);

	private final ClientLevel level;
	private final LocalPlayer player;
	private final Map<Long, NavCell> cells = new HashMap<>();
	private final Map<BlockState, Float> breakTicks = new IdentityHashMap<>();

	public LevelNavWorld(ClientLevel level, LocalPlayer player) {
		this.level = level;
		this.player = player;
	}

	@Override
	public NavCell cell(int x, int y, int z) {
		long key = NavPos.key(x, y, z);
		NavCell c = cells.get(key);
		if (c == null) {
			c = classify(new BlockPos(x, y, z));
			cells.put(key, c);
		}
		return c;
	}

	private NavCell classify(BlockPos pos) {
		if (level.isOutsideBuildHeight(pos.getY()) || !level.hasChunkAt(pos)) return NavCell.UNKNOWN;
		BlockState s = level.getBlockState(pos);
		FluidState fluid = s.getFluidState();
		if (fluid.is(FluidTags.LAVA)) return NavCell.LAVA;
		if (danger(s)) return NavCell.DANGER;
		if (s.is(BlockTags.CLIMBABLE) && !s.is(Blocks.SCAFFOLDING)) return NavCell.CLIMB;
		if (s.is(BlockTags.WOODEN_DOORS) || s.is(BlockTags.FENCE_GATES)) return NavCell.DOOR;
		VoxelShape shape = s.getCollisionShape(level, pos);
		// A carpet or a thin snow layer is stepped over without a jump.
		if (shape.isEmpty() || shape.max(Direction.Axis.Y) <= 0.2) {
			if (fluid.is(FluidTags.WATER)) return NavCell.WATER;
			return s.canBeReplaced() ? NavCell.AIR : NavCell.OPEN_FIXED;
		}
		// Doors that do not open by hand are walls; containers and machines are never dug, nor blocks
		// that leave water behind (waterlogged blocks, ice).
		if (s.getBlock() instanceof DoorBlock || s.hasBlockEntity() || !fluid.isEmpty() || s.is(Blocks.ICE)) return NavCell.WALL;
		float ticks = breakTicks(s, pos);
		if (shape.max(Direction.Axis.Y) > 1.0) return NavCell.tall(ticks);
		return NavCell.solid(ticks, s.getBlock() instanceof FallingBlock);
	}

	private static boolean danger(BlockState s) {
		return s.is(Blocks.FIRE) || s.is(Blocks.SOUL_FIRE) || s.is(Blocks.MAGMA_BLOCK) || s.is(Blocks.CACTUS)
				|| s.is(Blocks.SWEET_BERRY_BUSH) || s.is(Blocks.POWDER_SNOW) || s.is(Blocks.COBWEB)
				|| s.is(Blocks.WITHER_ROSE) || s.is(Blocks.POINTED_DRIPSTONE) || s.getBlock() instanceof CampfireBlock;
	}

	/** Ticks to break the block with the best hotbar item (enchantments and effects ignored), or -1. */
	private float breakTicks(BlockState s, BlockPos pos) {
		Float cached = breakTicks.get(s);
		if (cached != null) return cached;
		float hardness = s.getDestroySpeed(level, pos);
		float ticks;
		if (hardness < 0) {
			ticks = -1;
		} else if (hardness == 0) {
			ticks = 0;
		} else {
			Inventory inv = player.getInventory();
			ticks = Float.MAX_VALUE;
			for (int slot = 0; slot < 9; slot++) {
				ItemStack stack = inv.getItem(slot);
				boolean correct = !s.requiresCorrectToolForDrops() || stack.isCorrectToolForDrops(s);
				float speed = Math.max(1.0F, stack.getDestroySpeed(s));
				ticks = Math.min(ticks, (float) Math.ceil(hardness * (correct ? 30 : 100) / speed));
			}
		}
		breakTicks.put(s, ticks);
		return ticks;
	}

	/** Whether the item can be placed under the player to pillar up. */
	public static boolean throwaway(ItemStack stack) {
		return !stack.isEmpty() && THROWAWAY.contains(stack.getItem());
	}

	/** Throwaway blocks in the hotbar (the pillar move takes them from there). */
	public static int throwawayCount(LocalPlayer player) {
		int n = 0;
		for (int slot = 0; slot < 9; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (throwaway(stack)) n += stack.getCount();
		}
		return n;
	}
}
