package dev.mcpfabric.client.handlers;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.client.ClientMc;
import dev.mcpfabric.handlers.support.Levels;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.context.BlockPlaceContext;
import net.minecraft.world.level.block.AnvilBlock;
import net.minecraft.world.level.block.BellBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.CakeBlock;
import net.minecraft.world.level.block.CartographyTableBlock;
import net.minecraft.world.level.block.ComposterBlock;
import net.minecraft.world.level.block.CraftingTableBlock;
import net.minecraft.world.level.block.DiodeBlock;
import net.minecraft.world.level.block.FlowerPotBlock;
import net.minecraft.world.level.block.GrindstoneBlock;
import net.minecraft.world.level.block.LeverBlock;
import net.minecraft.world.level.block.LoomBlock;
import net.minecraft.world.level.block.NoteBlock;
import net.minecraft.world.level.block.RespawnAnchorBlock;
import net.minecraft.world.level.block.StonecutterBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Finds how to click so that the held block lands in a given cell with given properties. Where a
 * block faces, which half a slab or stair takes and which side a door hinges on follow the player's
 * rotation, the clicked face and the spot on it; instead of encoding those rules per block, every
 * click within reach is tried against the block's own placement logic and one that gives the wanted
 * state is chosen. Render thread only.
 */
final class PlacementPlanner {
	/** Yaw for each horizontal direction the player can face (Minecraft: 0 = south, 90 = west). */
	private static final float[] YAWS = {0F, 90F, 180F, -90F};
	/** Level, looking straight down, looking straight up (pistons, observers and dispensers use it). */
	private static final float[] PITCHES = {0F, 90F, -90F};
	/** Spots on a face, along its two in-plane axes: lower/upper half, left/right side. */
	private static final double[] SPOTS = {0.25, 0.75};

	private PlacementPlanner() {}

	/** A click that places the wanted state. */
	record Click(BlockPos against, Direction face, Vec3 hit, float yaw, float pitch, BlockState predicted) {
		BlockHitResult hitResult() {
			return new BlockHitResult(hit, face, against, false);
		}
	}

	/** The wanted block: id and the properties that must match (the others are free). */
	record Wanted(String id, Map<String, String> properties) {
		static Wanted parse(String text) throws RpcException {
			String s = text.trim().toLowerCase(Locale.ROOT);
			if (s.contains("{")) throw RpcException.badRequest("Block data ({...}) is not allowed here.");
			String id = s;
			Map<String, String> props = new LinkedHashMap<>();
			int open = s.indexOf('[');
			if (open >= 0) {
				if (!s.endsWith("]")) throw RpcException.badRequest("Malformed block state: " + text);
				id = s.substring(0, open);
				String body = s.substring(open + 1, s.length() - 1).trim();
				if (!body.isEmpty()) {
					for (String pair : body.split(",")) {
						int eq = pair.indexOf('=');
						if (eq <= 0) throw RpcException.badRequest("Malformed property '" + pair + "' in " + text);
						props.put(pair.substring(0, eq).trim(), pair.substring(eq + 1).trim());
					}
				}
			}
			if (!id.contains(":")) id = "minecraft:" + id;
			return new Wanted(id, props);
		}

		boolean matches(BlockState state) {
			if (!Levels.blockId(state).equals(id)) return false;
			JsonObject actual = Levels.properties(state);
			for (Map.Entry<String, String> e : properties.entrySet()) {
				JsonElement v = actual.get(e.getKey());
				if (v == null || !v.getAsString().equals(e.getValue())) return false;
			}
			return true;
		}
	}

	/** The outcome of a search: the chosen click, or why there is none. */
	record Result(Click click, String problem, Set<String> reachable) {}

	static Result plan(LocalPlayer p, BlockPos target, Wanted wanted) throws RpcException {
		ClientLevel level = ClientMc.level();
		ItemStack stack = p.getMainHandItem();
		if (!(stack.getItem() instanceof BlockItem item)) {
			throw RpcException.badRequest("The main hand holds no block; select the item for " + wanted.id() + " first.");
		}
		BlockState there = level.getBlockState(target);
		if (!there.canBeReplaced()) {
			return new Result(null, "occupied by " + Levels.blockState(there), Set.of());
		}

		float yaw0 = p.getYRot(), pitch0 = p.getXRot();
		List<Click> matches = new ArrayList<>();
		Set<String> reachable = new LinkedHashSet<>();
		boolean anySupport = false;
		boolean anyInReach = false;
		try {
			for (Direction face : Direction.values()) {
				BlockPos against = target.relative(face.getOpposite());
				BlockState clicked = level.getBlockState(against);
				if (clicked.isAir() || interactive(level, against, clicked)) continue;
				anySupport = true;
				if (!ClientMc.canReachBlock(p, against, 1.0)) continue;
				anyInReach = true;
				for (Vec3 hit : spots(against, face)) {
					for (float yaw : YAWS) {
						for (float pitch : PITCHES) {
							p.setYRot(yaw);
							p.setXRot(pitch);
							BlockState predicted = predict(p, stack, item, new BlockHitResult(hit, face, against, false), target);
							if (predicted == null) continue;
							reachable.add(Levels.blockState(predicted));
							if (wanted.matches(predicted)) matches.add(new Click(against, face, hit, yaw, pitch, predicted));
						}
					}
				}
			}
		} finally {
			p.setYRot(yaw0);
			p.setXRot(pitch0);
		}
		if (!anySupport) return new Result(null, "no_support", Set.of());
		if (!anyInReach) return new Result(null, "out_of_reach", Set.of());
		if (matches.isEmpty()) {
			return new Result(null, reachable.isEmpty() ? "cannot_place" : "no_click_gives_that_state", reachable);
		}
		// The smallest turn from where the player looks now.
		Click best = matches.get(0);
		for (Click c : matches) {
			if (turn(c, yaw0, pitch0) < turn(best, yaw0, pitch0)) best = c;
		}
		return new Result(best, null, reachable);
	}

	/** What the block would become for this click, or null when the click would not place it at {@code target}. */
	private static BlockState predict(LocalPlayer p, ItemStack stack, BlockItem item, BlockHitResult hit, BlockPos target) {
		BlockPlaceContext ctx = item.updatePlacementContext(new BlockPlaceContext(p, InteractionHand.MAIN_HAND, stack, hit));
		if (ctx == null || !ctx.canPlace() || !ctx.getClickedPos().equals(target)) return null;
		BlockState state = placementState(item, ctx);
		if (state == null || !state.canSurvive(ctx.getLevel(), target)) return null;
		if (!ctx.getLevel().isUnobstructed(state, target, CollisionContext.of(p))) return null;
		return state;
	}

	/**
	 * The block an item places for this click. Most items place their own block; torches, signs,
	 * banners and heads also have a wall variant and pick one by where the player looks, as
	 * StandingAndWallBlockItem does (its own method for it is not public). The wall variant is the
	 * other block the item registers itself for.
	 */
	private static BlockState placementState(BlockItem item, BlockPlaceContext ctx) {
		Block standing = item.getBlock();
		Map<Block, Item> blocks = new LinkedHashMap<>();
		item.registerBlocks(blocks, item);
		Block wall = null;
		for (Block b : blocks.keySet()) if (b != standing) wall = b;
		if (wall == null) return standing.getStateForPlacement(ctx);
		// Hanging signs hang from the block above; torches, signs, banners and heads stand on the one below.
		Direction attachment = Levels.blockId(standing.defaultBlockState()).contains("hanging") ? Direction.UP : Direction.DOWN;
		BlockState wallState = wall.getStateForPlacement(ctx);
		for (Direction d : ctx.getNearestLookingDirections()) {
			if (d == attachment.getOpposite()) continue;
			BlockState s = d == attachment ? standing.getStateForPlacement(ctx) : wallState;
			if (s != null && s.canSurvive(ctx.getLevel(), ctx.getClickedPos())) return s;
		}
		return null;
	}

	/** Four spots on the face of {@code pos} that points along {@code face}: lower/upper and left/right quarters. */
	private static List<Vec3> spots(BlockPos pos, Direction face) {
		List<Vec3> out = new ArrayList<>(4);
		Vec3 center = Vec3.atCenterOf(pos).add(face.getStepX() * 0.5, face.getStepY() * 0.5, face.getStepZ() * 0.5);
		for (double a : SPOTS) {
			for (double b : SPOTS) {
				double x = center.x, y = center.y, z = center.z;
				switch (face.getAxis()) {
					case X -> { y = pos.getY() + a; z = pos.getZ() + b; }
					case Y -> { x = pos.getX() + a; z = pos.getZ() + b; }
					case Z -> { y = pos.getY() + a; x = pos.getX() + b; }
				}
				out.add(new Vec3(x, y, z));
			}
		}
		return out;
	}

	private static double turn(Click c, float yaw0, float pitch0) {
		double dy = Math.abs(((c.yaw() - yaw0) % 360 + 540) % 360 - 180);
		return dy + Math.abs(c.pitch() - pitch0);
	}

	/**
	 * Blocks a right-click would use instead of placing against (open a menu, flip, light...). The
	 * agent cannot sneak to skip that, so they are not clicked.
	 */
	private static boolean interactive(ClientLevel level, BlockPos pos, BlockState s) {
		if (level.getBlockEntity(pos) != null) return true;
		if (s.is(BlockTags.DOORS) || s.is(BlockTags.TRAPDOORS) || s.is(BlockTags.FENCE_GATES) || s.is(BlockTags.BUTTONS)
				|| s.is(BlockTags.BEDS)) {
			return true;
		}
		Block b = s.getBlock();
		return b instanceof CraftingTableBlock || b instanceof LeverBlock || b instanceof AnvilBlock
				|| b instanceof StonecutterBlock || b instanceof GrindstoneBlock || b instanceof LoomBlock
				|| b instanceof CartographyTableBlock || b instanceof DiodeBlock || b instanceof NoteBlock
				|| b instanceof CakeBlock || b instanceof RespawnAnchorBlock || b instanceof ComposterBlock
				|| b instanceof FlowerPotBlock || b instanceof BellBlock;
	}
}
