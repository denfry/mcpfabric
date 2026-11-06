package dev.mcpfabric;

import dev.mcpfabric.bridge.DiscoveryFile;
import dev.mcpfabric.bridge.HttpBridgeServer;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.config.McpConfig;
import dev.mcpfabric.events.EventBus;
import dev.mcpfabric.bridge.SseHub;
import dev.mcpfabric.handlers.CommandHandlers;
import dev.mcpfabric.handlers.support.Approvals;
import dev.mcpfabric.handlers.EntityHandlers;
import dev.mcpfabric.handlers.InfoHandlers;
import dev.mcpfabric.handlers.PlayerAdminHandlers;
import dev.mcpfabric.handlers.SupervisedHandlers;
import dev.mcpfabric.handlers.WorldHandlers;
import dev.mcpfabric.platform.Platform;
import dev.mcpfabric.supervision.Supervisor;
import net.minecraft.server.MinecraftServer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Loader-independent core. The loader entrypoint ({@code dev.mcpfabric.fabric} /
 * {@code dev.mcpfabric.neoforge}) calls {@link #init(Platform)} once, then forwards server lifecycle
 * and tick events to the {@code on*} hooks below. Starts the embedded HTTP bridge and registers all
 * server-capable RPC handlers; client-only handlers are added later from {@code McpFabricClient}
 * into the same shared {@link RpcRouter}.
 */
public final class McpFabric {
	public static final String MOD_ID = "mcpfabric";
	public static final Logger LOGGER = LoggerFactory.getLogger("mcpfabric");

	private static Platform platform;
	private static McpConfig config;
	private static RpcRouter router;
	private static EventBus eventBus;
	private static SseHub sseHub;
	private static HttpBridgeServer httpServer;
	private static final Supervisor supervisor = new Supervisor();

	private McpFabric() {}

	public static Platform platform() {
		return platform;
	}

	public static McpConfig config() {
		return config;
	}

	public static RpcRouter router() {
		return router;
	}

	public static EventBus events() {
		return eventBus;
	}

	/** The supervised mode (#27): one session, finite authority and the action ledger. */
	public static Supervisor supervisor() {
		return supervisor;
	}

	public static void init(Platform loaderPlatform) {
		platform = loaderPlatform;
		config = McpConfig.load();
		sseHub = new SseHub();
		eventBus = new EventBus(sseHub);
		router = new RpcRouter();
		router.setGuard(Approvals::require);

		// Server-capable handlers. Game event listeners are wired by the loader entrypoint and feed
		// the bus through GameEvents.
		InfoHandlers.register(router);
		WorldHandlers.register(router);
		EntityHandlers.register(router);
		PlayerAdminHandlers.register(router);
		CommandHandlers.register(router);
		SupervisedHandlers.register(router);
		dev.mcpfabric.handlers.ChatHandlers.registerCommon(router, eventBus);

		// On a dedicated server, chat.send broadcasts. On a client the client entrypoint registers
		// chat.send to speak as the local player, so we must not also register the server variant.
		if (!platform.isClient()) {
			dev.mcpfabric.handlers.ChatHandlers.registerServerChat(router);
			dev.mcpfabric.handlers.SessionHandlers.registerServer(router);
		}

		httpServer = new HttpBridgeServer(config, router, eventBus, sseHub);
		try {
			httpServer.start();
			DiscoveryFile.write(config);
		} catch (Exception e) {
			LOGGER.error("[mcpfabric] failed to start HTTP bridge on {}:{}", config.host, config.port, e);
		}

		if (config.requireAuth) {
			LOGGER.info("[mcpfabric] ready ({}) — bridge http://{}:{} (token: {})", platform.loader(),
					config.host, config.port, config.source);
		} else {
			LOGGER.warn("[mcpfabric] ready ({}) — bridge http://{}:{} (authentication disabled)",
					platform.loader(), config.host, config.port);
		}
	}

	/** The running server (dedicated or integrated) finished starting. */
	public static void onServerStarted(MinecraftServer server) {
		ServerHolder.set(server);
		// On a client the context is the world the player is in, set by the client tick.
		if (!platform.isClient()) supervisor.enterContext("server:" + server.getWorldData().getLevelName());
	}

	public static void onServerStopping(MinecraftServer server) {
		// Keep the bridge up across integrated-server restarts on the client; only stop it on a
		// dedicated server shutdown.
		if (!platform.isClient()) {
			stopBridge();
		}
	}

	/**
	 * Stops the HTTP bridge. Its JDK dispatcher thread is not a daemon, so the JVM cannot exit
	 * until this runs: the dedicated server calls it on stop, the client when the game closes.
	 */
	public static void stopBridge() {
		if (httpServer != null) {
			httpServer.stop();
		}
		DiscoveryFile.remove();
	}

	public static void onServerStopped(MinecraftServer server) {
		ServerHolder.set(null);
		if (!platform.isClient()) supervisor.enterContext(null);
	}

	/** End of every server tick. */
	public static void onServerTick(MinecraftServer server) {
		try {
			eventBus.setTick(server.overworld().getGameTime());
		} catch (Throwable ignored) {
		}
	}
}
