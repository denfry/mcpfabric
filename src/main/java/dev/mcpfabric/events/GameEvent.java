package dev.mcpfabric.events;

import com.google.gson.JsonObject;

/** An observed game event held in the {@link EventBus} ring buffer and pushed over SSE. */
public record GameEvent(long id, String type, long gameTime, JsonObject data) {
	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.addProperty("id", id);
		o.addProperty("type", type);
		o.addProperty("gameTime", gameTime);
		o.add("data", data == null ? new JsonObject() : data);
		return o;
	}
}
