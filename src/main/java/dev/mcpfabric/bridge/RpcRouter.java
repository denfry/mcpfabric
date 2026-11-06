package dev.mcpfabric.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.mcpfabric.McpFabric;

import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Registry + dispatcher for RPC methods. Thread-safe: handlers can be registered from both the
 * common and client entrypoints, and dispatched from HTTP worker threads.
 */
public final class RpcRouter {
	private final Map<String, RpcHandler> handlers = new ConcurrentHashMap<>();
	private volatile Guard guard;

	/** Runs before every handler and may refuse the call (the player's approval). */
	public interface Guard {
		void check(String method, JsonObject params) throws RpcException;
	}

	public void setGuard(Guard g) {
		guard = g;
	}

	private volatile AuditLog audit;

	/** Calls with a lasting effect are recorded here; null turns the audit log off. */
	public void setAudit(AuditLog log) {
		audit = log;
	}

	public void register(String method, RpcHandler handler) {
		if (handlers.putIfAbsent(method, handler) != null) {
			McpFabric.LOGGER.warn("[mcpfabric] duplicate RPC method registration: {}", method);
		}
	}

	public boolean has(String method) {
		return handlers.containsKey(method);
	}

	/** Sorted list of all registered method names (for diagnostics / capabilities). */
	public JsonArray methodNames() {
		JsonArray a = new JsonArray();
		new TreeMap<>(handlers).keySet().forEach(a::add);
		return a;
	}

	/** Dispatch a call, returning a full RPC envelope ({ok:true,result} or {ok:false,error}). */
	public JsonObject dispatch(String method, JsonObject params) {
		if (method == null || method.isBlank()) {
			return Json.envelopeError("bad_request", "Missing 'method'.", null);
		}
		RpcHandler handler = handlers.get(method);
		if (handler == null) {
			return Json.envelopeError("unknown_method", "No such method: " + method, null);
		}
		long start = System.nanoTime();
		JsonObject envelope = invoke(handler, method, params);
		AuditLog log = audit;
		if (log != null) log.record(method, params, envelope, (System.nanoTime() - start) / 1_000_000);
		return envelope;
	}

	private JsonObject invoke(RpcHandler handler, String method, JsonObject params) {
		try {
			Guard g = guard;
			if (g != null) g.check(method, params);
			JsonElement result = handler.handle(new RpcContext(method, params));
			return Json.envelopeOk(result);
		} catch (RpcException e) {
			return Json.envelopeError(e.code(), e.getMessage(), e.data());
		} catch (Throwable t) {
			McpFabric.LOGGER.error("[mcpfabric] handler '{}' threw", method, t);
			return Json.envelopeError("internal", t.getClass().getSimpleName() + ": " + t.getMessage(), null);
		}
	}
}
