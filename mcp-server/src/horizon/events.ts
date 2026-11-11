import type { BridgeEvent } from "../bridge.js";

/** Horizon's events as the mod names them (`events.getRecent`, the channel). */
export function mapEvent(raw: Record<string, unknown>): BridgeEvent[] {
  const id = Number(raw.seq ?? 0);
  const gameTime = Number(raw.tick ?? 0);
  const { event, seq: _seq, tick: _tick, ...data } = raw;
  const make = (type: string, d: Record<string, unknown>): BridgeEvent => ({ id, type, gameTime, data: d });
  switch (event) {
    case "chat":
      // Horizon does not say who wrote a line, so it is never the local player's own request.
      return [make("chat", { text: data.text, kind: "unknown", self: false })];
    case "death":
      return [make("self_death", data)];
    case "hurt":
      return [make("self_health", { health: data.health, maxHealth: 20, lost: data.amount, ...(data.cause !== undefined ? { cause: data.cause } : {}) })];
    case "world":
      return data.state === "closed" ? [make("left_world", { screen: "title", disconnected: false })] : [make("world_opened", {})];
    case "dimension":
      return [make("dimension_change", { from: data.from, to: data.to })];
    case "screen":
      return [make("screen", { from: data.from, to: data.to })];
    default:
      return [make(String(event ?? "unknown"), data)];
  }
}
