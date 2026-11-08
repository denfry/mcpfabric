package dev.mcpfabric.handlers.support;

import dev.mcpfabric.McpFabric;
import dev.mcpfabric.bridge.RpcException;

/**
 * The capability locks of {@code mcpfabric.config.json}. Every handler that belongs to a gated
 * group checks its lock, so what {@code get_status} reports as disabled really is unavailable.
 */
public final class Gates {
	private Gates() {}

	/** Movement, looking, item use, inventory changes and navigation of the local player. */
	public static void playerControl() throws RpcException {
		if (!McpFabric.config().enablePlayerControl) {
			throw RpcException.unavailable("Player control is disabled in mcpfabric.config.json (enablePlayerControl=false).");
		}
		notPaused();
		Takeover.noteAction();
	}

	/**
	 * The player paused the AI and has control. Every action is refused until they resume it; do not
	 * retry in a loop.
	 */
	public static void notPaused() throws RpcException {
		if (Takeover.paused()) {
			throw RpcException.unavailable("The player paused the AI and has control (mcpfabric key or /mcpfabric stop). "
					+ "Actions are refused until they resume it; tell them what you were doing instead of retrying.");
		}
	}

	/**
	 * Clicking widgets and typing into text fields of the open screen. Off by default: menus reach
	 * settings and actions that the other tools never expose, so it needs its own flag on top of
	 * player control.
	 */
	public static void uiControl() throws RpcException {
		playerControl();
		if (!McpFabric.config().enableUiControl) {
			throw RpcException.unavailable("UI control is disabled in mcpfabric.config.json (enableUiControl=false).");
		}
	}

	/**
	 * The supervised mode (supervised.*). Its own lock: an operator can turn the other groups off and
	 * leave the model only narrow actions under finite authority. {@code supervised.stop} is not
	 * gated, so stopping always works.
	 */
	public static void supervised() throws RpcException {
		if (!McpFabric.config().enableSupervisedControl) {
			throw RpcException.unavailable("Supervised control is disabled in mcpfabric.config.json (enableSupervisedControl=false).");
		}
		notPaused();
	}

	/** Screenshots and scene descriptions. */
	public static void vision() throws RpcException {
		if (!McpFabric.config().enableVision) {
			throw RpcException.unavailable("Vision is disabled in mcpfabric.config.json (enableVision=false).");
		}
	}

	/** Anything that runs a server command, including the player admin tools (they run level-4 commands). */
	public static void commands() throws RpcException {
		if (!McpFabric.config().enableCommands) {
			throw RpcException.unavailable("Commands are disabled in mcpfabric.config.json (enableCommands=false).");
		}
		notPaused();
	}

	/** Block, time, weather and entity changes made on the server (world.set*, world.fill, entities.summon/remove). */
	public static void worldWrite() throws RpcException {
		if (!McpFabric.config().enableWorldWrite) {
			throw RpcException.unavailable("World writes are disabled in mcpfabric.config.json (enableWorldWrite=false).");
		}
		notPaused();
	}

	/**
	 * Block or entity data (NBT) can create a command block or command minecart that runs any command,
	 * so it is only accepted while commands are enabled.
	 */
	public static void dataTags(String data) throws RpcException {
		if (data != null && data.indexOf('{') >= 0 && !McpFabric.config().enableCommands) {
			throw RpcException.unavailable("Block and entity data ({...}) can run commands, and commands are disabled "
					+ "in mcpfabric.config.json (enableCommands=false).");
		}
	}
}
