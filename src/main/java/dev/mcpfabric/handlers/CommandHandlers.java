package dev.mcpfabric.handlers;

import dev.mcpfabric.McpFabric;
import dev.mcpfabric.ServerHolder;
import dev.mcpfabric.bridge.MainThread;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.handlers.support.CommandRunner;
import net.minecraft.server.MinecraftServer;

/** {@code command.run} — execute an arbitrary server command and capture its output. */
public final class CommandHandlers {
	private CommandHandlers() {}

	public static void register(RpcRouter router) {
		router.register("command.run", ctx -> {
			if (!McpFabric.config().enableCommands) {
				throw RpcException.unavailable("Command execution is disabled in mcpfabric.config.json (enableCommands=false).");
			}
			MinecraftServer server = ServerHolder.get();
			if (server == null) throw RpcException.noServer();

			String command = ctx.getString("command").strip();
			if (command.startsWith("/")) command = command.substring(1);
			final String cmd = command;
			if (cmd.isBlank()) throw RpcException.badRequest("Empty command.");

			return MainThread.call(server, McpFabric.config().callTimeoutMs,
					() -> CommandRunner.run(server, cmd).toJson());
		});
	}
}
