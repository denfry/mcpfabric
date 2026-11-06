package dev.mcpfabric.nav;

/** Block queries for the planner: the client level in game, a fake grid in tests. */
@FunctionalInterface
public interface NavWorld {
	NavCell cell(int x, int y, int z);

	default NavCell cell(NavPos p) {
		return cell(p.x(), p.y(), p.z());
	}
}
