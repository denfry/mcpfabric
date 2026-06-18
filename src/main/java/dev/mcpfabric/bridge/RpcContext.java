package dev.mcpfabric.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.List;

/** Typed, null-safe accessor over the {@code params} object of an RPC call. */
public final class RpcContext {
	private final String method;
	private final JsonObject params;

	public RpcContext(String method, JsonObject params) {
		this.method = method;
		this.params = params == null ? new JsonObject() : params;
	}

	public String method() {
		return method;
	}

	public JsonObject params() {
		return params;
	}

	public boolean has(String key) {
		return params.has(key) && !params.get(key).isJsonNull();
	}

	// --- required ----------------------------------------------------------------------------

	public String getString(String key) throws RpcException {
		require(key);
		return params.get(key).getAsString();
	}

	public int getInt(String key) throws RpcException {
		require(key);
		return params.get(key).getAsInt();
	}

	public double getDouble(String key) throws RpcException {
		require(key);
		return params.get(key).getAsDouble();
	}

	public JsonObject getObject(String key) throws RpcException {
		require(key);
		if (!params.get(key).isJsonObject()) throw RpcException.badRequest("Param '" + key + "' must be an object.");
		return params.getAsJsonObject(key);
	}

	// --- optional ----------------------------------------------------------------------------

	public String optString(String key, String def) {
		return has(key) ? params.get(key).getAsString() : def;
	}

	public int optInt(String key, int def) {
		return has(key) ? params.get(key).getAsInt() : def;
	}

	public long optLong(String key, long def) {
		return has(key) ? params.get(key).getAsLong() : def;
	}

	public double optDouble(String key, double def) {
		return has(key) ? params.get(key).getAsDouble() : def;
	}

	public boolean optBool(String key, boolean def) {
		return has(key) ? params.get(key).getAsBoolean() : def;
	}

	public Boolean optBoolean(String key) {
		return has(key) ? params.get(key).getAsBoolean() : null;
	}

	public JsonObject optObject(String key) {
		return has(key) && params.get(key).isJsonObject() ? params.getAsJsonObject(key) : null;
	}

	public List<String> getStringList(String key) {
		List<String> out = new ArrayList<>();
		if (has(key) && params.get(key).isJsonArray()) {
			JsonArray a = params.getAsJsonArray(key);
			for (JsonElement e : a) {
				if (!e.isJsonNull()) out.add(e.getAsString());
			}
		}
		return out;
	}

	private void require(String key) throws RpcException {
		if (!has(key)) throw RpcException.badRequest("Missing required param '" + key + "'.");
	}
}
