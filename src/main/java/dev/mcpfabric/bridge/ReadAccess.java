package dev.mcpfabric.bridge;

import java.util.Set;

/**
 * What the read-only token ({@code readToken}) may call: methods that only look at the game. They
 * still need their own lock (vision, perception, player control for screens), like with the full
 * token. Anything not listed here, including methods added later, is refused for that token.
 */
public final class ReadAccess {
	static final Set<String> METHODS = Set.of(
			"info.status", "info.capabilities", "session.info",
			"world.getBlock", "world.getBlocks", "world.findBlocks", "world.getTimeAndWeather", "world.getDimensions", "world.raycast",
			"entities.query", "entities.get", "players.list", "players.get",
			"chat.getRecent", "events.getRecent",
			"player.getState", "player.getInventory", "player.getEquipment", "player.getStatusEffects",
			"vision.screenshot", "vision.describeScene",
			"perception.scan", "perception.blocks", "perception.entities",
			"recipes.query", "nav.status", "screen.get", "ui.widgets", "session.worlds", "supervised.status");

	private ReadAccess() {}

	public static boolean allowed(String method) {
		return method != null && METHODS.contains(method);
	}
}
