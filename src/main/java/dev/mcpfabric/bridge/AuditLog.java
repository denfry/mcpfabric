package dev.mcpfabric.bridge;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import dev.mcpfabric.McpFabric;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;

/**
 * {@code logs/mcpfabric-audit.jsonl}: one line per call that changes the world, the player or other
 * players (commands, block and entity edits, player admin, chat, interactions, inventory moves out of
 * the player's hands, screens and supervised actions), with the time, the outcome and a short form of
 * the params. Movement, looking and reads are not logged: they are frequent and change nothing that
 * stays. Written on its own thread so neither the bridge nor the game waits for the disk; the file
 * rolls over to {@code .1} at 5 MiB. {@code auditLog: false} turns it off.
 */
public final class AuditLog {
	/** Methods with a lasting effect. A new method is not logged until it is added here. */
	static final Set<String> AUDITED = Set.of(
			"command.run", "chat.send",
			"world.setBlock", "world.fill", "world.setTime", "world.setWeather",
			"entities.summon", "entities.remove",
			"players.applyEffect", "players.give", "players.kick", "players.message", "players.setGameMode", "players.teleport",
			"interact.breakBlock", "interact.placeBlock", "interact.attackEntity", "interact.useEntity", "interact.useItem", "interact.dropItem",
			"inventory.dropSlot", "container.click", "container.transfer", "craft.place",
			"session.join", "ui.click", "ui.setText",
			"supervised.setBlock", "supervised.command", "supervised.enterWorld", "supervised.leaveWorld");
	/** Params that only identify the caller's session; they say nothing about the action. */
	private static final Set<String> SKIPPED = Set.of("session", "seq");
	private static final int MAX_VALUE = 200;
	static final long MAX_BYTES = 5L * 1024 * 1024;

	private final Path file;
	private final ExecutorService writer = Executors.newSingleThreadExecutor(r -> {
		Thread t = new Thread(r, "mcpfabric-audit");
		t.setDaemon(true);
		return t;
	});

	public AuditLog(Path file) {
		this.file = file;
	}

	public static boolean audited(String method) {
		return AUDITED.contains(method);
	}

	/** Records a finished call if its method is audited. Never throws. */
	public void record(String method, JsonObject params, JsonObject envelope, long millis) {
		if (!audited(method)) return;
		String line = line(Instant.now(), method, params, envelope, millis);
		try {
			writer.execute(() -> append(line));
		} catch (RejectedExecutionException e) {
			// closed: the game is shutting down
		}
	}

	static String line(Instant at, String method, JsonObject params, JsonObject envelope, long millis) {
		JsonObject o = new JsonObject();
		o.addProperty("at", at.toString());
		o.addProperty("method", method);
		boolean ok = envelope != null && envelope.has("ok") && envelope.get("ok").getAsBoolean();
		o.addProperty("ok", ok);
		if (!ok && envelope != null && envelope.has("error") && envelope.get("error").isJsonObject()) {
			JsonObject err = envelope.getAsJsonObject("error");
			if (err.has("code")) o.add("error", err.get("code"));
		}
		o.addProperty("ms", millis);
		JsonObject p = new JsonObject();
		if (params != null) {
			for (Map.Entry<String, JsonElement> e : params.entrySet()) {
				if (!SKIPPED.contains(e.getKey())) p.add(e.getKey(), shorten(e.getValue()));
			}
		}
		o.add("params", p);
		return Json.GSON.toJson(o);
	}

	private static JsonElement shorten(JsonElement v) {
		if (v.isJsonPrimitive() && !v.getAsJsonPrimitive().isString()) return v;
		String s = v.isJsonPrimitive() ? v.getAsString() : Json.GSON.toJson(v);
		return new JsonPrimitive(s.length() > MAX_VALUE ? s.substring(0, MAX_VALUE) + "..." : s);
	}

	private void append(String line) {
		try {
			Files.createDirectories(file.getParent());
			if (Files.exists(file) && Files.size(file) > MAX_BYTES) {
				Files.move(file, file.resolveSibling(file.getFileName() + ".1"), StandardCopyOption.REPLACE_EXISTING);
			}
			Files.writeString(file, line + "\n", StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
		} catch (IOException | RuntimeException e) {
			McpFabric.LOGGER.warn("[mcpfabric] could not write the audit log {}: {}", file, e.toString());
		}
	}

	/** Writes the pending lines and stops the writer (bridge shutdown, tests). */
	public void close() {
		writer.shutdown();
		try {
			writer.awaitTermination(2, TimeUnit.SECONDS);
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
		}
	}
}
