package dev.mcpfabric.client.nav;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.BlockGetter;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;

/**
 * A small A* pathfinder over block positions for walking bots. Considers same-level walking,
 * a one-block step-up (jump), and dropping down up to three blocks. Walkability is derived from
 * block collision shapes, so it works on any {@link BlockGetter} (client or server level).
 */
public final class AStarPathfinder {
	private final BlockGetter level;
	private final int maxNodes;

	public AStarPathfinder(BlockGetter level, int maxNodes) {
		this.level = level;
		this.maxNodes = maxNodes;
	}

	private boolean passable(BlockPos pos) {
		return level.getBlockState(pos).getCollisionShape(level, pos).isEmpty();
	}

	private boolean hasGround(BlockPos pos) {
		return !passable(pos);
	}

	/** Can the bot's body occupy this position (feet here, head above, solid below)? */
	private boolean canStand(BlockPos feet) {
		return passable(feet) && passable(feet.above()) && hasGround(feet.below());
	}

	/** @return a path of block positions (excluding start, ending at/near goal), or null if none. */
	public List<BlockPos> findPath(BlockPos start, BlockPos goal, double reachRadius) {
		Node startNode = new Node(start, 0, heuristic(start, goal), null);
		PriorityQueue<Node> open = new PriorityQueue<>();
		Map<Long, Double> best = new HashMap<>();
		open.add(startNode);
		best.put(start.asLong(), 0.0);

		int expanded = 0;
		while (!open.isEmpty() && expanded < maxNodes) {
			Node current = open.poll();
			expanded++;

			if (withinReach(current.pos, goal, reachRadius)) {
				return reconstruct(current);
			}

			for (Direction dir : Direction.Plane.HORIZONTAL) {
				BlockPos h = current.pos.relative(dir);
				BlockPos next = null;
				double moveCost = 1.0;

				if (canStand(h)) {
					next = h;
				} else if (canStand(h.above()) && passable(current.pos.above().above())) {
					next = h.above(); // step / jump up
					moveCost = 1.5;
				} else {
					for (int d = 1; d <= 3; d++) {
						if (canStand(h.below(d))) {
							next = h.below(d);
							moveCost = 1.0 + 0.3 * d;
							break;
						}
					}
				}
				if (next == null) continue;

				double tentativeG = current.g + moveCost;
				long key = next.asLong();
				Double prev = best.get(key);
				if (prev != null && tentativeG >= prev) continue;
				best.put(key, tentativeG);
				open.add(new Node(next.immutable(), tentativeG, heuristic(next, goal), current));
			}
		}
		return null;
	}

	private static boolean withinReach(BlockPos a, BlockPos goal, double reach) {
		double dx = a.getX() - goal.getX();
		double dy = a.getY() - goal.getY();
		double dz = a.getZ() - goal.getZ();
		return Math.sqrt(dx * dx + dy * dy + dz * dz) <= Math.max(0.75, reach);
	}

	private static double heuristic(BlockPos a, BlockPos b) {
		double dx = a.getX() - b.getX();
		double dy = a.getY() - b.getY();
		double dz = a.getZ() - b.getZ();
		return Math.sqrt(dx * dx + dy * dy + dz * dz);
	}

	private static List<BlockPos> reconstruct(Node end) {
		List<BlockPos> path = new ArrayList<>();
		for (Node n = end; n != null && n.parent != null; n = n.parent) {
			path.add(n.pos);
		}
		Collections.reverse(path);
		return path;
	}

	private static final class Node implements Comparable<Node> {
		final BlockPos pos;
		final double g;
		final double f;
		final Node parent;

		Node(BlockPos pos, double g, double h, Node parent) {
			this.pos = pos;
			this.g = g;
			this.f = g + h;
			this.parent = parent;
		}

		@Override
		public int compareTo(Node o) {
			return Double.compare(this.f, o.f);
		}
	}
}
