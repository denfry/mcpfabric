package dev.mcpfabric.handlers.support;

/**
 * The player's override. While the player has paused the AI (the mcpfabric key or
 * {@code /mcpfabric stop} on the client), {@link Gates#notPaused()} refuses every action (player
 * control, supervised actions, commands, world and entity writes, chat sent as the player), so
 * jobs, scripts and single calls all stop at their next step. Reads keep working. On a dedicated
 * server nobody can pause, so it stays off.
 */
public final class Takeover {
	private static volatile boolean paused;
	private static volatile long lastActionMillis;

	private Takeover() {}

	public static boolean paused() {
		return paused;
	}

	public static void setPaused(boolean value) {
		paused = value;
	}

	/** An action passed the player-control gate: the client shows that the AI has control. */
	public static void noteAction() {
		lastActionMillis = System.currentTimeMillis();
	}

	public static long lastActionMillis() {
		return lastActionMillis;
	}
}
