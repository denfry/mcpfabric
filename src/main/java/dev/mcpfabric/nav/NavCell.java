package dev.mcpfabric.nav;

/**
 * What the planner needs to know about one block cell.
 *
 * @param kind        how the body can use the cell
 * @param breakTicks  ticks to break it with the best hotbar item; negative means never dig it
 * @param gravity     falls when the block under it is removed (sand, gravel, concrete powder)
 * @param replaceable a placed block can take its place (air, grass, snow layer), for pillaring
 */
public record NavCell(Kind kind, float breakTicks, boolean gravity, boolean replaceable) {
	public enum Kind {
		/** Nothing to collide with (air, flowers, torches...). */
		OPEN,
		/** Water without a collision shape: swimmable. */
		WATER,
		/** Ladder or vine: passable, and the body can climb it. */
		CLIMB,
		/** A door or fence gate the player can open by hand: passable. */
		DOOR,
		/** A collision shape up to one block high: blocks the body, can be stood on. */
		SOLID,
		/** Fence or wall: taller than a block, so it blocks the body and cannot be stood on. */
		TALL,
		/** Hurts or traps the body (fire, magma, cactus, powder snow, cobweb...): never entered or dug. */
		DANGER,
		/** Lava: never entered, and nothing next to it is dug. */
		LAVA,
		/** Not loaded or outside the build height. */
		UNKNOWN
	}

	public static final NavCell AIR = new NavCell(Kind.OPEN, 0, false, true);
	/** Passable but not replaceable (a flower, a torch): it is no place for a pillar block. */
	public static final NavCell OPEN_FIXED = new NavCell(Kind.OPEN, 0, false, false);
	public static final NavCell WATER = new NavCell(Kind.WATER, -1, false, true);
	public static final NavCell CLIMB = new NavCell(Kind.CLIMB, -1, false, false);
	public static final NavCell DOOR = new NavCell(Kind.DOOR, -1, false, false);
	public static final NavCell DANGER = new NavCell(Kind.DANGER, -1, false, false);
	public static final NavCell LAVA = new NavCell(Kind.LAVA, -1, false, false);
	public static final NavCell UNKNOWN = new NavCell(Kind.UNKNOWN, -1, false, false);
	/** A solid block that is never dug (bedrock, a container, an iron door). */
	public static final NavCell WALL = new NavCell(Kind.SOLID, -1, false, false);

	public static NavCell solid(float breakTicks, boolean gravity) {
		return new NavCell(Kind.SOLID, breakTicks, gravity, false);
	}

	public static NavCell tall(float breakTicks) {
		return new NavCell(Kind.TALL, breakTicks, false, false);
	}

	/** The body can be in this cell. */
	public boolean passable() {
		return kind == Kind.OPEN || kind == Kind.WATER || kind == Kind.CLIMB || kind == Kind.DOOR;
	}

	/** A body standing on top of this cell is supported. */
	public boolean ground() {
		return kind == Kind.SOLID;
	}

	/** The block could be broken at all (the planner adds its own safety checks). */
	public boolean breakable() {
		return (kind == Kind.SOLID || kind == Kind.TALL) && breakTicks >= 0;
	}
}
