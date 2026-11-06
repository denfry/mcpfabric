package dev.mcpfabric.nav;

/** A block position for the planner, free of Minecraft types so the planner can be unit-tested. */
public record NavPos(int x, int y, int z) {
	public NavPos above() {
		return new NavPos(x, y + 1, z);
	}

	public NavPos above(int n) {
		return new NavPos(x, y + n, z);
	}

	public NavPos below() {
		return new NavPos(x, y - 1, z);
	}

	public NavPos below(int n) {
		return new NavPos(x, y - n, z);
	}

	public NavPos offset(int dx, int dy, int dz) {
		return new NavPos(x + dx, y + dy, z + dz);
	}

	public long key() {
		return key(x, y, z);
	}

	/** Packs a position into one long (26 bits x, 26 bits z, 12 bits y), like vanilla's BlockPos.asLong. */
	public static long key(int x, int y, int z) {
		return ((long) (x & 0x3FFFFFF) << 38) | ((long) (z & 0x3FFFFFF) << 12) | (y & 0xFFF);
	}
}
