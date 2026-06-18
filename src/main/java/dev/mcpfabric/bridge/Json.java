package dev.mcpfabric.bridge;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/** Small Gson helpers used across the bridge. */
public final class Json {
	public static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

	private Json() {}

	public static JsonObject obj() {
		return new JsonObject();
	}

	public static JsonArray arr() {
		return new JsonArray();
	}

	public static JsonObject ok(String message) {
		JsonObject o = new JsonObject();
		o.addProperty("ok", true);
		if (message != null) o.addProperty("message", message);
		return o;
	}

	/** Wraps a successful result into the RPC envelope. */
	public static JsonObject envelopeOk(JsonElement result) {
		JsonObject o = new JsonObject();
		o.addProperty("ok", true);
		o.add("result", result == null ? new JsonObject() : result);
		return o;
	}

	/** Wraps an error into the RPC envelope. */
	public static JsonObject envelopeError(String code, String message, JsonElement data) {
		JsonObject err = new JsonObject();
		err.addProperty("code", code);
		err.addProperty("message", message);
		if (data != null) err.add("data", data);
		JsonObject o = new JsonObject();
		o.addProperty("ok", false);
		o.add("error", err);
		return o;
	}
}
