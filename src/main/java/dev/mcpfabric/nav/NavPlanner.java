package dev.mcpfabric.nav;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.PriorityQueue;

/**
 * A* over block cells for the walking bot. Besides walking, stepping up one block and dropping
 * down, it can open doors, swim at the surface, climb ladders and vines, dig through breakable
 * blocks and pillar up on throwaway blocks. Each move has a cost in "blocks walked"; digging costs
 * by the time it takes to break the block with the best hotbar item, so the bot only tunnels when
 * the way around is longer.
 *
 * <p>Safety rules: it never enters or digs fire, lava, magma and the like; never digs a block that
 * touches water or lava (it would flood the path); never digs the block under the player's feet;
 * never digs under sand or gravel that would fall onto the player's head, and pays for clearing a
 * short column of falling blocks elsewhere; never drops more than three blocks unless it lands in
 * water or on a ladder; never swims under water.
 */
public final class NavPlanner {
	/** Highest drop onto ground without fall damage. */
	public static final int MAX_SAFE_DROP = 3;
	/** Highest drop into water or onto a ladder (they cancel fall damage). */
	public static final int MAX_SOFT_DROP = 24;
	/** Falling blocks above a dug cell the planner is willing to clear (they fall and are dug again). */
	public static final int MAX_FALLING_COLUMN = 3;
	/** Break ticks per cost unit: walking one block takes about 4.6 ticks. */
	static final double TICKS_PER_COST = 4.0;
	/** Fixed cost of each dug block on top of its break time: tool switch, aiming, waiting for drops. */
	static final double DIG_OVERHEAD = 1.0;

	static final double WALK = 1.0;
	static final double WADE = 1.5;
	static final double SWIM = 2.5;
	static final double DOOR = 2.0;
	static final double JUMP = 1.6;
	static final double CLIMB_UP = 1.6;
	static final double CLIMB_DOWN = 1.2;
	static final double SWIM_UP = 1.2;
	static final double PILLAR = 4.0;
	static final double NEAR_LAVA = 6.0;

	private static final int[][] DIRS = {{0, -1}, {0, 1}, {1, 0}, {-1, 0}};

	/** The kind of move that reaches a step; the executor drives each one differently. */
	public enum Move {
		WALK, JUMP, FALL, SWIM, CLIMB, PILLAR, DIG, DOOR;

		public String id() {
			return name().toLowerCase(Locale.ROOT);
		}
	}

	/**
	 * Which moves are allowed.
	 *
	 * @param pillarBlocks throwaway blocks available, so at most this many pillar moves per path
	 */
	public record Options(boolean dig, boolean pillar, boolean swim, int pillarBlocks, int maxNodes) {}

	/**
	 * One step of a path: where the feet end up, how, and which cells must be dug first (top
	 * first; already open cells may be listed too, the executor skips them).
	 */
	public record Step(NavPos pos, Move move, List<NavPos> dig) {}

	private final NavWorld world;
	private final Options opts;

	public NavPlanner(NavWorld world, Options opts) {
		this.world = world;
		this.opts = opts;
	}

	/** @return the steps from {@code start} (exclusive) to a cell within {@code reach} of the goal, or null. */
	public List<Step> findPath(NavPos start, NavPos goal, double reach) {
		PriorityQueue<Node> open = new PriorityQueue<>();
		Map<Long, Double> best = new HashMap<>();
		open.add(new Node(start, 0, heuristic(start, goal), null, null, List.of(), 0));
		best.put(start.key(), 0.0);
		List<Node> next = new ArrayList<>();

		int expanded = 0;
		while (!open.isEmpty() && expanded < opts.maxNodes()) {
			Node current = open.poll();
			Double known = best.get(current.pos.key());
			if (known != null && current.g > known) continue; // a cheaper way here was found later
			expanded++;
			if (withinReach(current.pos, goal, reach)) {
				return reconstruct(current);
			}
			next.clear();
			expand(current, goal, next);
			for (Node n : next) {
				long key = n.pos.key();
				Double prev = best.get(key);
				if (prev != null && n.g >= prev) continue;
				best.put(key, n.g);
				open.add(n);
			}
		}
		return null;
	}

	// --- moves ---------------------------------------------------------------------------------

	private void expand(Node cur, NavPos goal, List<Node> out) {
		NavPos p = cur.pos;
		NavCell feet = c(p);
		// After a pillar move the block under the feet is the one just placed, which the world does not show yet.
		boolean grounded = c(p.below()).ground() || cur.move == Move.PILLAR;
		boolean canJump = grounded || feet.kind() == NavCell.Kind.WATER || feet.kind() == NavCell.Kind.CLIMB;
		boolean headroom = open(p.above(2));

		for (int[] d : DIRS) {
			NavPos h = p.offset(d[0], 0, d[1]);
			NavCell hc = c(h);
			boolean hFree = hc.passable() && c(h.above()).passable();

			if (canOccupy(h)) {
				out.add(node(cur, h, flatMove(h), List.of(), flatCost(h), goal, 0));
			} else if (hFree && hc.kind() != NavCell.Kind.WATER && c(h.above()).kind() != NavCell.Kind.WATER) {
				fall(cur, h, goal, out);
			}

			NavPos up = h.above();
			if (!hFree && canJump && headroom && canOccupy(up)) {
				out.add(node(cur, up, Move.JUMP, List.of(), JUMP, goal, 0));
			}

			if (!opts.dig()) continue;
			// Tunnel straight ahead.
			if (!hFree && (grounded || feet.kind() == NavCell.Kind.CLIMB) && c(h.below()).ground()) {
				List<NavPos> cells = List.of(h.above(), h);
				double cost = digCost(cells, null);
				if (cost > 0) out.add(node(cur, h, Move.DIG, cells, WALK + cost, goal, 0));
			}
			// Dig a step up: headroom above the player, then the two cells on top of the block ahead.
			if (grounded && hc.ground()) {
				List<NavPos> cells = List.of(p.above(2), up.above(), up);
				double cost = digCost(cells, p.above(2));
				if (cost > 0) out.add(node(cur, up, Move.DIG, cells, JUMP + cost, goal, 0));
			}
			// Dig a step down: the body passes through the cell ahead, then drops into the one below it.
			if (grounded && c(h.below(2)).ground()) {
				List<NavPos> cells = List.of(h.above(), h, h.below());
				double cost = digCost(cells, null);
				if (cost > 0) out.add(node(cur, h.below(), Move.DIG, cells, WALK + 0.3 + cost, goal, 0));
			}
		}

		// Climb a ladder or vine up / down.
		NavPos above = p.above();
		if (c(above).kind() == NavCell.Kind.CLIMB && (feet.kind() == NavCell.Kind.CLIMB || grounded) && canOccupy(above)) {
			out.add(node(cur, above, Move.CLIMB, List.of(), CLIMB_UP, goal, 0));
		}
		NavPos below = p.below();
		if (c(below).kind() == NavCell.Kind.CLIMB && canOccupy(below)) {
			out.add(node(cur, below, Move.CLIMB, List.of(), CLIMB_DOWN, goal, 0));
		}
		// Rise to the surface.
		if (opts.swim() && feet.kind() == NavCell.Kind.WATER && c(above).kind() == NavCell.Kind.WATER) {
			out.add(node(cur, above, Move.SWIM, List.of(), SWIM_UP, goal, 0));
		}
		// Pillar: jump and place a block where the feet were.
		if (opts.pillar() && cur.pillars < opts.pillarBlocks() && grounded
				&& feet.kind() == NavCell.Kind.OPEN && feet.replaceable() && open(above)) {
			if (headroom) {
				out.add(node(cur, above, Move.PILLAR, List.of(), PILLAR, goal, 1));
			} else if (opts.dig()) {
				List<NavPos> cells = List.of(p.above(2));
				double cost = digCost(cells, p.above(2));
				if (cost > 0) out.add(node(cur, above, Move.PILLAR, cells, PILLAR + cost, goal, 1));
			}
		}
	}

	/** Walk off the edge into {@code h} and fall to the first cell that holds the body. */
	private void fall(Node cur, NavPos h, NavPos goal, List<Node> out) {
		for (int d = 1; d <= MAX_SOFT_DROP; d++) {
			NavPos land = h.below(d);
			NavCell lc = c(land);
			if (canOccupy(land)) {
				boolean soft = lc.kind() == NavCell.Kind.WATER || lc.kind() == NavCell.Kind.CLIMB;
				if (d > MAX_SAFE_DROP && !soft) return;
				out.add(node(cur, land, Move.FALL, List.of(), WALK + 0.3 * d + (soft && d > MAX_SAFE_DROP ? 1.0 : 0), goal, 0));
				return;
			}
			if (!lc.passable() || lc.kind() == NavCell.Kind.WATER) return;
		}
	}

	private Move flatMove(NavPos h) {
		if (c(h).kind() == NavCell.Kind.DOOR || c(h.above()).kind() == NavCell.Kind.DOOR) return Move.DOOR;
		if (c(h).kind() == NavCell.Kind.WATER) return c(h.below()).ground() ? Move.WALK : Move.SWIM;
		return Move.WALK;
	}

	private double flatCost(NavPos h) {
		NavCell feet = c(h);
		double cost;
		if (feet.kind() == NavCell.Kind.WATER) cost = c(h.below()).ground() ? WADE : SWIM;
		else if (feet.kind() == NavCell.Kind.DOOR || c(h.above()).kind() == NavCell.Kind.DOOR) cost = DOOR;
		else cost = WALK;
		return cost;
	}

	// --- cells ---------------------------------------------------------------------------------

	private NavCell c(NavPos p) {
		return world.cell(p);
	}

	/** Open air (or a door / ladder) for the body, not water. */
	private boolean open(NavPos p) {
		NavCell cell = c(p);
		return cell.passable() && cell.kind() != NavCell.Kind.WATER;
	}

	/** Can the body rest with its feet in {@code p}: room for feet and head, and something holding it. */
	boolean canOccupy(NavPos p) {
		NavCell feet = c(p);
		NavCell head = c(p.above());
		if (!feet.passable() || !head.passable() || head.kind() == NavCell.Kind.WATER) return false;
		boolean ground = c(p.below()).ground();
		if (feet.kind() == NavCell.Kind.WATER) return ground || opts.swim();
		return ground || feet.kind() == NavCell.Kind.CLIMB;
	}

	/**
	 * Cost of clearing {@code cells}, 0 when they are all open already, or -1 when one cannot be
	 * dug safely. {@code noFallingAbove} is the cell over the player's head: nothing may fall into it.
	 */
	double digCost(List<NavPos> cells, NavPos noFallingAbove) {
		double cost = 0;
		for (NavPos cell : cells) {
			NavCell cc = c(cell);
			if (cc.kind() == NavCell.Kind.WATER) return -1;
			if (cc.passable()) continue;
			if (!opts.dig() || !cc.breakable() || floodRisk(cell)) return -1;
			cost += DIG_OVERHEAD + cc.breakTicks() / TICKS_PER_COST;
			if (cells.contains(cell.above())) continue;
			// Sand or gravel resting on the top dug cell falls into it and has to be dug again.
			for (int k = 1; ; k++) {
				NavCell fallingCell = c(cell.above(k));
				if (!fallingCell.gravity()) break;
				if (cell.equals(noFallingAbove) || k > MAX_FALLING_COLUMN || floodRisk(cell.above(k))) return -1;
				cost += DIG_OVERHEAD + fallingCell.breakTicks() / TICKS_PER_COST;
			}
		}
		return cost;
	}

	/** Water or lava next to the cell would flow into the hole. */
	private boolean floodRisk(NavPos p) {
		return fluid(p.above()) || fluid(p.below()) || fluid(p.offset(1, 0, 0)) || fluid(p.offset(-1, 0, 0))
				|| fluid(p.offset(0, 0, 1)) || fluid(p.offset(0, 0, -1));
	}

	private boolean fluid(NavPos p) {
		NavCell.Kind k = c(p).kind();
		return k == NavCell.Kind.WATER || k == NavCell.Kind.LAVA;
	}

	private boolean nearLava(NavPos p) {
		for (int[] d : DIRS) {
			if (c(p.offset(d[0], 0, d[1])).kind() == NavCell.Kind.LAVA) return true;
			if (c(p.offset(d[0], 1, d[1])).kind() == NavCell.Kind.LAVA) return true;
		}
		return c(p.below()).kind() == NavCell.Kind.LAVA;
	}

	// --- search plumbing -----------------------------------------------------------------------

	private Node node(Node cur, NavPos pos, Move move, List<NavPos> dig, double cost, NavPos goal, int pillars) {
		double g = cur.g + cost + (nearLava(pos) ? NEAR_LAVA : 0);
		return new Node(pos, g, heuristic(pos, goal), cur, move, dig, cur.pillars + pillars);
	}

	private static boolean withinReach(NavPos a, NavPos goal, double reach) {
		return heuristic(a, goal) <= Math.max(0.75, reach);
	}

	private static double heuristic(NavPos a, NavPos b) {
		double dx = a.x() - b.x();
		double dy = a.y() - b.y();
		double dz = a.z() - b.z();
		return Math.sqrt(dx * dx + dy * dy + dz * dz);
	}

	private static List<Step> reconstruct(Node end) {
		List<Step> path = new ArrayList<>();
		for (Node n = end; n != null && n.parent != null; n = n.parent) {
			path.add(new Step(n.pos, n.move, n.dig));
		}
		Collections.reverse(path);
		return path;
	}

	private static final class Node implements Comparable<Node> {
		final NavPos pos;
		final double g;
		final double f;
		final Node parent;
		final Move move;
		final List<NavPos> dig;
		final int pillars;

		Node(NavPos pos, double g, double h, Node parent, Move move, List<NavPos> dig, int pillars) {
			this.pos = pos;
			this.g = g;
			this.f = g + h;
			this.parent = parent;
			this.move = move;
			this.dig = dig;
			this.pillars = pillars;
		}

		@Override
		public int compareTo(Node o) {
			return Double.compare(this.f, o.f);
		}
	}
}
