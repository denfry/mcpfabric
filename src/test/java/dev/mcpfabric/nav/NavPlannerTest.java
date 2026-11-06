package dev.mcpfabric.nav;

import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class NavPlannerTest {
	/** Stone with a wooden pickaxe: about 22 ticks. */
	private static final NavCell STONE = NavCell.solid(22, false);
	private static final NavCell SAND = NavCell.solid(15, true);

	/** A flat world: stone up to y=0, air above, nothing loaded beyond 12 blocks from the origin. */
	private static final class Grid implements NavWorld {
		final Map<Long, NavCell> cells = new HashMap<>();

		@Override
		public NavCell cell(int x, int y, int z) {
			if (Math.abs(x) > 12 || Math.abs(z) > 12 || y < -20 || y > 40) return NavCell.UNKNOWN;
			NavCell c = cells.get(NavPos.key(x, y, z));
			if (c != null) return c;
			return y <= 0 ? STONE : NavCell.AIR;
		}

		Grid set(int x, int y, int z, NavCell c) {
			cells.put(NavPos.key(x, y, z), c);
			return this;
		}

		/** A wall across the whole world along z = {@code z}, from y=1 to y=height. */
		Grid wall(int z, int height, NavCell c) {
			for (int x = -12; x <= 12; x++) {
				for (int y = 1; y <= height; y++) set(x, y, z, c);
			}
			return this;
		}

		/** Replace the ground of the strip zFrom..zTo with water down to y=-depth+1. */
		Grid river(int zFrom, int zTo, int depth) {
			for (int x = -12; x <= 12; x++) {
				for (int z = zFrom; z <= zTo; z++) {
					for (int y = 0; y > -depth; y--) set(x, y, z, NavCell.WATER);
				}
			}
			return this;
		}
	}

	private static NavPlanner.Options opts(boolean dig, boolean pillar, boolean swim, int blocks) {
		return new NavPlanner.Options(dig, pillar, swim, blocks, 20000);
	}

	private static final NavPlanner.Options WALK_ONLY = opts(false, false, false, 0);
	private static final NavPlanner.Options ALL = opts(true, true, true, 64);

	private static List<NavPlanner.Step> path(Grid g, NavPlanner.Options o, NavPos from, NavPos to) {
		return new NavPlanner(g, o).findPath(from, to, 0.5);
	}

	private static boolean uses(List<NavPlanner.Step> path, NavPlanner.Move move) {
		return path.stream().anyMatch(s -> s.move() == move);
	}

	@Test
	void walksStraightOnFlatGround() {
		List<NavPlanner.Step> p = path(new Grid(), ALL, new NavPos(0, 1, 0), new NavPos(0, 1, 6));
		assertNotNull(p);
		assertEquals(6, p.size());
		assertTrue(p.stream().allMatch(s -> s.move() == NavPlanner.Move.WALK));
		assertEquals(new NavPos(0, 1, 6), p.get(p.size() - 1).pos());
	}

	@Test
	void stepsUpOneBlockWithoutDigging() {
		Grid g = new Grid().wall(3, 1, STONE);
		List<NavPlanner.Step> p = path(g, ALL, new NavPos(0, 1, 0), new NavPos(0, 2, 3));
		assertNotNull(p);
		assertTrue(uses(p, NavPlanner.Move.JUMP));
		assertFalse(uses(p, NavPlanner.Move.DIG));
	}

	@Test
	void digsThroughAWallOnlyWhenAllowed() {
		Grid g = new Grid().wall(3, 4, STONE);
		NavPos from = new NavPos(0, 1, 0);
		NavPos to = new NavPos(0, 1, 6);
		assertNull(path(g, opts(false, false, false, 0), from, to));

		List<NavPlanner.Step> p = path(g, opts(true, false, false, 0), from, to);
		assertNotNull(p);
		NavPlanner.Step dig = p.stream().filter(s -> s.move() == NavPlanner.Move.DIG).findFirst().orElseThrow();
		assertEquals(new NavPos(0, 1, 3), dig.pos());
		assertEquals(List.of(new NavPos(0, 2, 3), new NavPos(0, 1, 3)), dig.dig());
	}

	@Test
	void neverDigsUnbreakableBlocks() {
		// Bedrock from the bottom of the world up: no way through, over or under.
		Grid g = new Grid();
		for (int x = -12; x <= 12; x++) {
			for (int y = -20; y <= 4; y++) g.set(x, y, 3, NavCell.WALL);
		}
		assertNull(path(g, opts(true, false, true, 0), new NavPos(0, 1, 0), new NavPos(0, 1, 6)));
	}

	@Test
	void neverDigsNextToWaterOrLava() {
		// A one-thick wall with a moat right behind it: a hole in the wall would flood, so the only
		// way is a tunnel under the moat.
		Grid g = new Grid().wall(3, 4, STONE);
		for (int x = -12; x <= 12; x++) {
			for (int y = 1; y <= 4; y++) g.set(x, y, 4, y % 2 == 0 ? NavCell.WATER : NavCell.LAVA);
		}
		NavPlanner planner = new NavPlanner(g, opts(true, false, false, 0));
		assertEquals(-1, planner.digCost(List.of(new NavPos(0, 1, 3)), null));
		List<NavPlanner.Step> p = planner.findPath(new NavPos(0, 1, 0), new NavPos(0, 1, 6), 0.5);
		assertNotNull(p);
		for (NavPlanner.Step s : p) {
			for (NavPos cell : s.dig()) {
				for (NavPos n : List.of(cell.above(), cell.below(), cell.offset(1, 0, 0), cell.offset(-1, 0, 0), cell.offset(0, 0, 1), cell.offset(0, 0, -1))) {
					NavCell.Kind k = g.cell(n).kind();
					assertTrue(k != NavCell.Kind.WATER && k != NavCell.Kind.LAVA, "dug " + cell + " next to a fluid");
				}
			}
		}
	}

	@Test
	void prefersWalkingAroundOverDigging() {
		// A short wall with an open end two blocks to the side.
		Grid g = new Grid();
		for (int x = -12; x <= 2; x++) {
			for (int y = 1; y <= 3; y++) g.set(x, y, 3, STONE);
		}
		List<NavPlanner.Step> p = path(g, ALL, new NavPos(0, 1, 0), new NavPos(0, 1, 6));
		assertNotNull(p);
		assertFalse(uses(p, NavPlanner.Move.DIG));
	}

	@Test
	void pillarsUpToAFloatingPlatform() {
		Grid g = new Grid().set(0, 3, 5, STONE);
		NavPos from = new NavPos(0, 1, 0);
		NavPos goal = new NavPos(0, 4, 5);
		assertNull(path(g, WALK_ONLY, from, goal));
		assertNull(path(g, opts(false, true, false, 1), from, goal), "one block does not reach high enough");

		// Two pillar blocks lift the feet to y=3, and a jump climbs onto the platform.
		List<NavPlanner.Step> p = path(g, opts(false, true, false, 3), from, goal);
		assertNotNull(p);
		assertEquals(2, p.stream().filter(s -> s.move() == NavPlanner.Move.PILLAR).count());
		assertEquals(goal, p.get(p.size() - 1).pos());
	}

	@Test
	void swimsAcrossARiverOnlyWhenAllowed() {
		Grid g = new Grid().river(3, 6, 6);
		NavPos from = new NavPos(0, 1, 0);
		NavPos to = new NavPos(0, 1, 9);
		assertNull(path(g, WALK_ONLY, from, to));
		List<NavPlanner.Step> p = path(g, opts(false, false, true, 0), from, to);
		assertNotNull(p);
		assertTrue(uses(p, NavPlanner.Move.SWIM));
		// Swimming happens at the surface: feet in the top water cell, head in the air.
		p.stream().filter(s -> s.move() == NavPlanner.Move.SWIM).forEach(s -> assertEquals(0, s.pos().y()));
	}

	@Test
	void wadesThroughShallowWaterWithoutSwimming() {
		Grid g = new Grid().river(3, 6, 1);
		assertNotNull(path(g, WALK_ONLY, new NavPos(0, 1, 0), new NavPos(0, 1, 9)));
	}

	@Test
	void avoidsHighDropsUnlessTheyEndInWater() {
		// Standing on a 6-high tower; the only way down is a drop.
		Grid g = new Grid();
		for (int x = -12; x <= 12; x++) {
			for (int z = -12; z <= 2; z++) {
				for (int y = 1; y <= 6; y++) g.set(x, y, z, STONE);
			}
		}
		NavPos top = new NavPos(0, 7, 0);
		NavPos below = new NavPos(0, 1, 6);
		assertNull(path(g, WALK_ONLY, top, below));

		g.river(3, 4, 3);
		List<NavPlanner.Step> p = path(g, opts(false, false, true, 0), top, below);
		assertNotNull(p);
		NavPlanner.Step fall = p.stream().filter(s -> s.move() == NavPlanner.Move.FALL).findFirst().orElseThrow();
		assertEquals(0, fall.pos().y(), "lands in the water");
	}

	@Test
	void climbsALadder() {
		Grid g = new Grid().wall(3, 6, NavCell.WALL);
		for (int y = 1; y <= 6; y++) g.set(0, y, 2, NavCell.CLIMB);
		NavPos goal = new NavPos(0, 7, 3);
		List<NavPlanner.Step> p = path(g, WALK_ONLY, new NavPos(0, 1, 0), goal);
		assertNotNull(p);
		assertTrue(uses(p, NavPlanner.Move.CLIMB));
		assertEquals(goal, p.get(p.size() - 1).pos());
	}

	@Test
	void passesThroughDoors() {
		Grid g = new Grid().wall(3, 4, NavCell.WALL).set(0, 1, 3, NavCell.DOOR).set(0, 2, 3, NavCell.DOOR);
		List<NavPlanner.Step> p = path(g, WALK_ONLY, new NavPos(0, 1, 0), new NavPos(0, 1, 6));
		assertNotNull(p);
		assertTrue(uses(p, NavPlanner.Move.DOOR));
	}

	@Test
	void neverEntersDangerousBlocks() {
		Grid g = new Grid();
		for (int x = -12; x <= 12; x++) g.set(x, 1, 3, NavCell.DANGER).set(x, 2, 3, NavCell.DANGER);
		assertNull(path(g, opts(false, true, true, 64), new NavPos(0, 1, 0), new NavPos(0, 1, 6)));
	}

	@Test
	void fallingBlocksOverTheHeadAreNeverDug() {
		Grid g = new Grid().set(0, 3, 0, STONE).set(0, 4, 0, SAND);
		NavPlanner planner = new NavPlanner(g, ALL);
		NavPos overHead = new NavPos(0, 3, 0);
		assertEquals(-1, planner.digCost(List.of(overHead), overHead));
		// Elsewhere a short column of sand is cleared at extra cost, a tall one is refused.
		g.set(5, 3, 5, STONE);
		double plain = planner.digCost(List.of(new NavPos(5, 3, 5)), null);
		g.set(5, 4, 5, SAND).set(5, 5, 5, SAND);
		assertTrue(planner.digCost(List.of(new NavPos(5, 3, 5)), null) > plain);
		g.set(5, 6, 5, SAND).set(5, 7, 5, SAND);
		assertEquals(-1, planner.digCost(List.of(new NavPos(5, 3, 5)), null));
	}

	@Test
	void digCostGrowsWithBreakTime() {
		Grid g = new Grid().set(0, 1, 1, NavCell.solid(10, false)).set(0, 1, 2, NavCell.solid(100, false));
		NavPlanner planner = new NavPlanner(g, ALL);
		double soft = planner.digCost(List.of(new NavPos(0, 1, 1)), null);
		double hard = planner.digCost(List.of(new NavPos(0, 1, 2)), null);
		assertTrue(soft > 0 && hard > soft);
		assertEquals(0, planner.digCost(List.of(new NavPos(0, 5, 0)), null), "air needs no digging");
	}

	@Test
	void tunnelsDownWithoutDiggingUnderTheFeet() {
		// Enclosed in stone: the goal is three blocks down and ahead.
		Grid g = new Grid();
		for (int x = -12; x <= 12; x++) {
			for (int z = -12; z <= 12; z++) {
				for (int y = 1; y <= 4; y++) g.set(x, y, z, STONE);
			}
		}
		g.set(0, 1, 0, NavCell.AIR).set(0, 2, 0, NavCell.AIR);
		NavPos start = new NavPos(0, 1, 0);
		List<NavPlanner.Step> p = path(g, opts(true, false, false, 0), start, new NavPos(0, -2, 4));
		assertNotNull(p);
		NavPos at = start;
		for (NavPlanner.Step s : p) {
			for (NavPos cell : s.dig()) assertFalse(cell.equals(at.below()), "dug under the feet at " + at);
			at = s.pos();
		}
	}
}
