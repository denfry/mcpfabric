package dev.mcpfabric.config;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import dev.mcpfabric.McpFabric;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Persistent configuration for the bridge, stored at {@code config/mcpfabric.config.json}.
 * An auth token is generated on first run and remains in the config file so it does not leak into
 * logs. Copy it into the MCP server's {@code MCPFABRIC_TOKEN} environment variable.
 */
public final class McpConfig {
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

	/** Bind host. Keep on loopback unless you really know what you are doing. */
	public String host = "127.0.0.1";
	public int port = 25599;
	/** Shared secret required in the Authorization: Bearer header. */
	public String token = "";
	/**
	 * When false, any program on this machine can use the bridge without the token. Web pages are still
	 * refused (they send an Origin header), but binding to loopback alone would not stop them.
	 */
	public boolean requireAuth = true;
	/**
	 * A second bearer token that may only read the game (ReadAccess): give it to an observer, a
	 * dashboard or a model that should watch but not act. Generated on first run.
	 */
	public String readToken = "";

	/** Max time a single RPC may block the game thread before timing out. */
	public int callTimeoutMs = 8000;

	/**
	 * Secret that turns a server address into an opaque world id (session.info), so the agent's memory
	 * stays per server without the address reaching the MCP client or its database. Generated on first
	 * run; never sent over the bridge.
	 */
	public String worldIdKey = "";

	/**
	 * Write the bridge address and token to ~/.mcpfabric/bridge.json while the game runs, so the MCP
	 * server connects without MCPFABRIC_TOKEN. The file is readable only by this user.
	 */
	public boolean writeDiscoveryFile = true;

	/**
	 * Record every call with a lasting effect (commands, world and entity edits, player admin, chat,
	 * interactions) in logs/mcpfabric-audit.jsonl next to the game's own logs.
	 */
	public boolean auditLog = true;

	// capability gates ------------------------------------------------------------------------
	public boolean enableWorldWrite = true;
	public boolean enableCommands = true;
	public boolean enablePlayerControl = true;
	public boolean enableVision = true;
	/** Generic control of game screens (ui.*). Off by default; also needs enablePlayerControl. */
	public boolean enableUiControl = false;
	/**
	 * Supervised mode (supervised.*): one narrow action per call under short-lived authority. Off by
	 * default. It is its own lock and does not need the flags above, so they can stay off.
	 */
	public boolean enableSupervisedControl = false;
	/** Save folders supervised_enter_world may open (disposable worlds). Empty: none. */
	public List<String> supervisedWorlds = new ArrayList<>();
	/** Command roots supervised_command may run; data ({...}) is refused in every command. */
	public List<String> supervisedCommands = new ArrayList<>(List.of("time", "weather"));

	public transient Path source;

	public static McpConfig load() {
		Path dir = McpFabric.platform().configDir();
		Path file = dir.resolve("mcpfabric.config.json");
		McpConfig cfg;
		if (Files.exists(file)) {
			try {
				cfg = GSON.fromJson(Files.readString(file), McpConfig.class);
				if (cfg == null) cfg = new McpConfig();
			} catch (Exception e) {
				McpFabric.LOGGER.error("[mcpfabric] failed to read config, using defaults", e);
				cfg = new McpConfig();
			}
		} else {
			cfg = new McpConfig();
		}
		if (cfg.token == null || cfg.token.isBlank()) {
			cfg.token = UUID.randomUUID().toString().replace("-", "");
		}
		if (cfg.readToken == null || cfg.readToken.isBlank()) {
			cfg.readToken = UUID.randomUUID().toString().replace("-", "");
		}
		if (cfg.worldIdKey == null || cfg.worldIdKey.isBlank()) {
			cfg.worldIdKey = UUID.randomUUID().toString().replace("-", "");
		}
		if (cfg.supervisedWorlds == null) cfg.supervisedWorlds = new ArrayList<>();
		if (cfg.supervisedCommands == null) cfg.supervisedCommands = new ArrayList<>();
		cfg.source = file;
		cfg.save();
		return cfg;
	}

	public void save() {
		try {
			if (source == null) {
				source = McpFabric.platform().configDir().resolve("mcpfabric.config.json");
			}
			Files.createDirectories(source.getParent());
			Files.writeString(source, GSON.toJson(this));
		} catch (IOException e) {
			McpFabric.LOGGER.error("[mcpfabric] failed to write config", e);
		}
	}
}
