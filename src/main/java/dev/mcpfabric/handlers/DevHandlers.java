package dev.mcpfabric.handlers;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.mcpfabric.McpFabric;
import dev.mcpfabric.ServerHolder;
import dev.mcpfabric.bridge.MainThread;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.handlers.support.Gates;
import dev.mcpfabric.handlers.support.Redact;
import dev.mcpfabric.platform.Platform;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.ServerTickRateManager;

import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Deque;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Developer tools ({@code dev.*}, behind {@code enableDevTools}): the game's log and crash reports,
 * the loaded mods, the built-in registries and the server's tick rate. Text read from files is
 * passed through {@link Redact} so addresses do not reach the model.
 */
public final class DevHandlers {
	static final int MAX_ENTRIES = 1000;
	static final int MAX_ENTRY_CHARS = 4000;
	static final int MAX_CRASH_CHARS = 200_000;
	/** Only the end of a log is read: enough for recent entries without loading a huge file. */
	private static final long TAIL_BYTES = 8L * 1024 * 1024;
	private static final long MAX_CRASH_FILE_BYTES = 4L * 1024 * 1024;
	private static final int MAX_TICKS = 72_000;
	/** The level in a log4j header: "[12:34:56] [Server thread/WARN]" (Fabric), "[...] [main/WARN] [...]" (NeoForge). */
	private static final Pattern HEADER = Pattern.compile("^\\[[^\\]]{1,40}] \\[[^\\]]{0,80}/(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)]");
	private static final List<String> LEVELS = List.of("TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL");

	private DevHandlers() {}

	public static void register(RpcRouter router) {
		router.register("dev.mods", ctx -> {
			Gates.devTools();
			JsonArray mods = new JsonArray();
			List<Platform.ModInfo> list = new ArrayList<>(McpFabric.platform().mods());
			list.sort(Comparator.comparing(Platform.ModInfo::id));
			for (Platform.ModInfo m : list) {
				JsonObject o = new JsonObject();
				o.addProperty("id", m.id());
				o.addProperty("name", m.name());
				o.addProperty("version", m.version());
				mods.add(o);
			}
			JsonObject o = new JsonObject();
			o.addProperty("loader", McpFabric.platform().loader());
			o.addProperty("count", mods.size());
			o.add("mods", mods);
			return o;
		});

		router.register("dev.registry", ctx -> {
			Gates.devTools();
			int limit = Math.max(1, Math.min(ctx.optInt("limit", 500), 5000));
			return registry(ctx.optString("registry", null), ctx.optString("namespace", null), ctx.optString("contains", null), limit);
		});

		router.register("dev.log", ctx -> {
			Gates.devTools();
			String file = ctx.optString("file", "latest");
			if (!file.equals("latest") && !file.equals("debug")) throw RpcException.badRequest("file must be latest or debug.");
			int max = Math.max(1, Math.min(ctx.optInt("lines", 100), MAX_ENTRIES));
			String level = ctx.optString("level", null);
			if (level != null && !LEVELS.contains(level.toUpperCase(Locale.ROOT))) {
				throw RpcException.badRequest("level must be one of " + String.join(", ", LEVELS) + ".");
			}
			Path path = gameDir().resolve("logs").resolve(file + ".log");
			if (!Files.isRegularFile(path)) throw RpcException.notFound("There is no logs/" + file + ".log.");
			Tail tail = tail(path);
			List<String> entries = entries(tail.lines(), level == null ? null : level.toUpperCase(Locale.ROOT), ctx.optString("contains", null), max);
			JsonArray out = new JsonArray();
			for (String e : entries) out.add(Redact.text(e));
			JsonObject o = new JsonObject();
			o.addProperty("file", "logs/" + file + ".log");
			o.addProperty("entries", out.size());
			o.addProperty("onlyEnd", tail.cut());
			o.add("log", out);
			return o;
		});

		router.register("dev.crash", ctx -> {
			Gates.devTools();
			int index = Math.max(0, ctx.optInt("index", 0));
			int maxChars = Math.max(1000, Math.min(ctx.optInt("maxChars", 20_000), MAX_CRASH_CHARS));
			List<Path> files = crashReports(gameDir().resolve("crash-reports"));
			JsonObject o = new JsonObject();
			o.addProperty("count", files.size());
			JsonArray recent = new JsonArray();
			for (Path f : files.subList(0, Math.min(10, files.size()))) {
				JsonObject r = new JsonObject();
				r.addProperty("file", f.getFileName().toString());
				r.addProperty("modified", modified(f));
				recent.add(r);
			}
			o.add("recent", recent);
			if (files.isEmpty()) return o;
			if (index >= files.size()) throw RpcException.notFound("There are " + files.size() + " crash reports; index " + index + " is past the oldest.");
			Path f = files.get(index);
			String text;
			try {
				long size = Files.size(f);
				text = size > MAX_CRASH_FILE_BYTES ? readHead(f, MAX_CRASH_FILE_BYTES) : Files.readString(f, StandardCharsets.UTF_8);
			} catch (IOException e) {
				throw RpcException.unavailable("Could not read " + f.getFileName() + ": " + e.getMessage());
			}
			text = Redact.text(text);
			o.addProperty("file", f.getFileName().toString());
			o.addProperty("modified", modified(f));
			o.addProperty("truncated", text.length() > maxChars);
			o.addProperty("text", text.length() > maxChars ? text.substring(0, maxChars) : text);
			return o;
		});

		router.register("dev.tick", ctx -> {
			Gates.devTools();
			String action = ctx.optString("action", "query").toLowerCase(Locale.ROOT);
			// Changing the tick rate is what /tick does, so it also needs commands.
			if (!action.equals("query")) Gates.commands();
			int ticks = action.equals("step") || action.equals("sprint") ? ctx.getInt("ticks") : 0;
			if ((action.equals("step") || action.equals("sprint")) && (ticks < 1 || ticks > MAX_TICKS)) {
				throw RpcException.badRequest("ticks must be 1-" + MAX_TICKS + ".");
			}
			float rate = action.equals("rate") ? (float) ctx.getDouble("rate") : 0f;
			if (action.equals("rate") && !(rate >= 1f && rate <= 10_000f)) throw RpcException.badRequest("rate must be 1-10000 ticks per second.");
			MinecraftServer server = ServerHolder.get();
			if (server == null) throw RpcException.noServer();
			return MainThread.call(server, McpFabric.config().callTimeoutMs, () -> {
				ServerTickRateManager m = server.tickRateManager();
				switch (action) {
					case "query" -> { }
					case "freeze" -> m.setFrozen(true);
					case "unfreeze" -> m.setFrozen(false);
					case "step" -> {
						if (!m.stepGameIfPaused(ticks)) throw RpcException.badRequest("step needs a frozen game: freeze it first.");
					}
					case "sprint" -> m.requestGameToSprint(ticks);
					case "stop_sprint" -> m.stopSprinting();
					case "rate" -> m.setTickRate(rate);
					default -> throw RpcException.badRequest("action must be query, freeze, unfreeze, step, sprint, stop_sprint or rate.");
				}
				JsonObject o = new JsonObject();
				o.addProperty("action", action);
				o.addProperty("rate", m.tickrate());
				o.addProperty("frozen", m.isFrozen());
				o.addProperty("sprinting", m.isSprinting());
				return o;
			});
		});
	}

	/** The registries (no name) or the ids of one built-in registry, filtered and sorted. */
	@SuppressWarnings({"rawtypes", "unchecked"})
	static JsonObject registry(String name, String namespace, String contains, int limit) throws RpcException {
		// Raw types: the key class is ResourceLocation before 1.21.11 and Identifier after; only its
		// text ("minecraft:stone") is used.
		Registry root = BuiltInRegistries.REGISTRY;
		JsonObject o = new JsonObject();
		if (name == null || name.isBlank()) {
			List<String> names = new ArrayList<>();
			for (Object r : root) names.add(String.valueOf(root.getKey(r)) + " " + ((Registry) r).keySet().size());
			Collections.sort(names);
			JsonArray a = new JsonArray();
			for (String n : names) {
				int sp = n.lastIndexOf(' ');
				JsonObject e = new JsonObject();
				e.addProperty("registry", n.substring(0, sp));
				e.addProperty("size", Integer.parseInt(n.substring(sp + 1)));
				a.add(e);
			}
			o.add("registries", a);
			return o;
		}
		String wanted = name.contains(":") ? name : "minecraft:" + name;
		for (Object r : root) {
			if (!wanted.equals(String.valueOf(root.getKey(r)))) continue;
			List<String> ids = new ArrayList<>();
			for (Object key : ((Registry) r).keySet()) {
				String id = String.valueOf(key);
				if (namespace != null && !id.startsWith(namespace + ":")) continue;
				if (contains != null && !id.contains(contains)) continue;
				ids.add(id);
			}
			Collections.sort(ids);
			JsonArray a = new JsonArray();
			for (String id : ids.subList(0, Math.min(limit, ids.size()))) a.add(id);
			o.addProperty("registry", wanted);
			o.addProperty("matched", ids.size());
			o.addProperty("truncated", ids.size() > limit);
			o.add("ids", a);
			return o;
		}
		throw RpcException.notFound("No built-in registry " + wanted + "; call it without a registry to list them (data-driven ones such as biomes are not included).");
	}

	/**
	 * Log entries, newest last: a header line with its continuation lines (stack traces). Keeps the
	 * last {@code max} entries at {@code level} or above that contain {@code contains}.
	 */
	static List<String> entries(List<String> lines, String level, String contains, int max) {
		int minLevel = level == null ? 0 : LEVELS.indexOf(level);
		Deque<String> out = new ArrayDeque<>();
		StringBuilder current = null;
		int currentLevel = -1;
		for (String raw : lines) {
			String line = raw.length() > MAX_ENTRY_CHARS ? raw.substring(0, MAX_ENTRY_CHARS) : raw;
			Matcher m = HEADER.matcher(line);
			if (m.find()) {
				keep(out, current, currentLevel, minLevel, contains, max);
				current = new StringBuilder(line);
				currentLevel = LEVELS.indexOf(m.group(1));
			} else if (current != null) {
				if (current.length() < MAX_ENTRY_CHARS) current.append('\n').append(line);
			} else {
				// Lines before the first header in the part read: their entry started earlier and its
				// level is unknown, so a level filter leaves them out.
				current = new StringBuilder(line);
				currentLevel = level == null ? 0 : -1;
			}
		}
		keep(out, current, currentLevel, minLevel, contains, max);
		return new ArrayList<>(out);
	}

	private static void keep(Deque<String> out, StringBuilder entry, int level, int minLevel, String contains, int max) {
		if (entry == null || level < minLevel) return;
		String text = entry.length() > MAX_ENTRY_CHARS ? entry.substring(0, MAX_ENTRY_CHARS) : entry.toString();
		if (contains != null && !text.contains(contains)) return;
		out.addLast(text);
		while (out.size() > max) out.removeFirst();
	}

	record Tail(List<String> lines, boolean cut) {}

	private static Tail tail(Path path) throws RpcException {
		try (RandomAccessFile f = new RandomAccessFile(path.toFile(), "r")) {
			long len = f.length();
			long start = Math.max(0, len - TAIL_BYTES);
			byte[] buf = new byte[(int) (len - start)];
			f.seek(start);
			f.readFully(buf);
			List<String> lines = new ArrayList<>(new String(buf, StandardCharsets.UTF_8).lines().toList());
			// The first line of a cut read is a partial one.
			if (start > 0 && !lines.isEmpty()) lines.remove(0);
			return new Tail(lines, start > 0);
		} catch (IOException e) {
			throw RpcException.unavailable("Could not read " + path.getFileName() + ": " + e.getMessage());
		}
	}

	private static String readHead(Path path, long bytes) throws IOException {
		try (RandomAccessFile f = new RandomAccessFile(path.toFile(), "r")) {
			byte[] buf = new byte[(int) Math.min(bytes, f.length())];
			f.readFully(buf);
			return new String(buf, StandardCharsets.UTF_8);
		}
	}

	private static List<Path> crashReports(Path dir) throws RpcException {
		if (!Files.isDirectory(dir)) return List.of();
		try (Stream<Path> s = Files.list(dir)) {
			return s.filter(p -> p.getFileName().toString().endsWith(".txt") && Files.isRegularFile(p))
					.sorted(Comparator.comparingLong(DevHandlers::lastModified).reversed())
					.toList();
		} catch (IOException e) {
			throw RpcException.unavailable("Could not list crash-reports: " + e.getMessage());
		}
	}

	private static long lastModified(Path p) {
		try {
			return Files.getLastModifiedTime(p).toMillis();
		} catch (IOException e) {
			return 0L;
		}
	}

	private static String modified(Path p) {
		return Instant.ofEpochMilli(lastModified(p)).toString();
	}

	/** The game folder: the parent of the config folder, as for the audit log. */
	private static Path gameDir() {
		Path config = McpFabric.platform().configDir().toAbsolutePath().normalize();
		Path parent = config.getParent();
		return parent == null ? config : parent;
	}
}
