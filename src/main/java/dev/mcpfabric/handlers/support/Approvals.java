package dev.mcpfabric.handlers.support;

import com.google.gson.JsonObject;
import dev.mcpfabric.McpFabric;
import dev.mcpfabric.bridge.RpcException;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/**
 * The player approves risky calls one by one. Groups listed in {@code requireApproval} (command,
 * world_write, players_admin) wait on the bridge thread, for at most {@link #TIMEOUT_SECONDS}, until
 * the player approves or denies them in the game (key or {@code /mcpfabric approve|deny}). No answer
 * is a denial. Only a client can answer: on a dedicated server those groups are refused.
 */
public final class Approvals {
	public static final int TIMEOUT_SECONDS = 60;
	private static final int MAX_PENDING = 5;
	private static final int MAX_SUMMARY = 160;

	public static final Set<String> GROUPS = Set.of("command", "world_write", "players_admin");
	private static final Map<String, String> GROUP_OF = Map.ofEntries(
			Map.entry("command.run", "command"),
			Map.entry("world.setBlock", "world_write"), Map.entry("world.fill", "world_write"),
			Map.entry("world.setTime", "world_write"), Map.entry("world.setWeather", "world_write"),
			Map.entry("entities.summon", "world_write"), Map.entry("entities.remove", "world_write"),
			Map.entry("players.applyEffect", "players_admin"), Map.entry("players.give", "players_admin"),
			Map.entry("players.kick", "players_admin"), Map.entry("players.message", "players_admin"),
			Map.entry("players.setGameMode", "players_admin"), Map.entry("players.teleport", "players_admin"));

	/** A call waiting for the player. */
	public record Pending(int id, String method, String summary, CompletableFuture<Boolean> answer) {}

	private static final AtomicInteger NEXT = new AtomicInteger(1);
	private static final Map<Integer, Pending> PENDING = new ConcurrentHashMap<>();
	private static volatile Consumer<Pending> prompt;

	private Approvals() {}

	/** The client shows new requests to the player through this. */
	public static void onRequest(Consumer<Pending> listener) {
		prompt = listener;
	}

	/** The approval group of a call, or null when it never needs one. */
	static String groupOf(String method, JsonObject params) {
		if ("chat.send".equals(method) && params != null && params.has("message")
				&& params.get("message").isJsonPrimitive() && params.get("message").getAsString().startsWith("/")) {
			return "command";
		}
		return GROUP_OF.get(method);
	}

	/** Blocks until the player answers when the call's group needs approval; throws when it is refused. */
	public static void require(String method, JsonObject params) throws RpcException {
		String group = groupOf(method, params);
		if (group == null || !McpFabric.config().requireApproval.contains(group)) return;
		Consumer<Pending> show = prompt;
		if (show == null) {
			throw RpcException.unavailable("'" + group + "' needs the player's approval (requireApproval), and only a game client can give it.");
		}
		if (PENDING.size() >= MAX_PENDING) {
			throw RpcException.unavailable("Too many requests are waiting for the player's approval; wait for an answer first.");
		}
		Pending p = new Pending(NEXT.getAndIncrement(), method, summary(method, params), new CompletableFuture<>());
		PENDING.put(p.id(), p);
		JsonObject ev = new JsonObject();
		ev.addProperty("id", p.id());
		ev.addProperty("method", method);
		McpFabric.events().emit("approval_requested", ev);
		boolean approved;
		try {
			show.accept(p);
			approved = p.answer().get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
		} catch (TimeoutException e) {
			approved = false;
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			approved = false;
		} catch (ExecutionException | RuntimeException e) {
			approved = false;
		} finally {
			PENDING.remove(p.id());
		}
		JsonObject done = new JsonObject();
		done.addProperty("id", p.id());
		done.addProperty("approved", approved);
		McpFabric.events().emit("approval_answered", done);
		if (!approved) {
			throw RpcException.unavailable("The player did not approve this (" + p.summary() + "). Do not retry it unasked; tell them what you need instead.");
		}
	}

	/** Answers one request (id) or, with id 0, the oldest one. Returns the answered request or null. */
	public static Pending answer(int id, boolean approve) {
		Pending p = id == 0 ? oldest() : PENDING.get(id);
		if (p == null) return null;
		p.answer().complete(approve);
		return p;
	}

	/** Denies everything that is waiting (the player paused the AI). */
	public static void denyAll() {
		for (Pending p : List.copyOf(PENDING.values())) p.answer().complete(false);
	}

	public static List<Pending> pending() {
		List<Pending> list = new ArrayList<>(PENDING.values());
		list.sort((a, b) -> Integer.compare(a.id(), b.id()));
		return list;
	}

	private static Pending oldest() {
		List<Pending> list = pending();
		return list.isEmpty() ? null : list.get(0);
	}

	/** What the player reads: the command itself, or the method with its params. */
	static String summary(String method, JsonObject params) {
		String text;
		if (("command.run".equals(method) || "chat.send".equals(method)) && params != null) {
			String key = "command.run".equals(method) ? "command" : "message";
			String c = params.has(key) && params.get(key).isJsonPrimitive() ? params.get(key).getAsString().strip() : "";
			text = c.startsWith("/") || "chat.send".equals(method) ? c : "/" + c;
		} else {
			text = method + " " + (params == null ? "{}" : params.toString());
		}
		// Formatting codes and control characters could disguise what is asked.
		text = text.replaceAll("[\u00a7\\p{Cntrl}]", "");
		return text.length() > MAX_SUMMARY ? text.substring(0, MAX_SUMMARY) + "..." : text;
	}
}
