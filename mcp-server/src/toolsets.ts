/**
 * Tool sets: which tools the server serves. Every tool costs model context, and a model picks
 * better from 20 tools than from 90, so `MCPFABRIC_TOOLSETS` narrows the catalogue to a profile
 * (`play`, `admin`, `build`) or to named groups (`supervised`, `world`, ...). `get_status` and
 * `list_capabilities` are always served, so the model can still see what the game allows.
 *
 * Tool sets only hide tools. The mod's `enable*` locks still decide what a call may do.
 */

/** Groups of bridge tools, by the namespace of the RPC method they call. */
const METHOD_GROUPS: Record<string, string> = {
  info: "info",
  world: "world",
  entities: "entities",
  players: "operator",
  command: "operator",
  chat: "chat",
  events: "events",
  player: "player",
  control: "player",
  interact: "player",
  inventory: "player",
  nav: "player",
  vision: "vision",
  screen: "session",
  session: "session",
  ui: "ui",
  supervised: "supervised",
};

/** Every group a tool can belong to; `agent` holds the agent runtime tools. */
export const TOOL_GROUPS = [...new Set([...Object.values(METHOD_GROUPS), "agent"])].sort();

/** Named profiles, each a union of groups. */
export const TOOL_PROFILES: Record<string, readonly string[]> = {
  all: TOOL_GROUPS,
  play: ["info", "player", "vision", "chat", "events", "session", "agent"],
  admin: ["info", "world", "entities", "operator", "chat", "events"],
  build: ["info", "world", "vision", "chat"],
};

/** The group of a bridge tool, from its RPC method. */
export function groupOfMethod(method: string): string {
  const group = METHOD_GROUPS[method.split(".")[0] ?? ""];
  if (!group) throw new Error(`no tool group for bridge method "${method}"`);
  return group;
}

/**
 * Parses `MCPFABRIC_TOOLSETS`: a comma-separated list of profiles and groups. Empty means all.
 * Throws on an unknown name, so a typo does not silently serve the wrong tools.
 */
export function parseToolsets(value: string | undefined): Set<string> {
  const names = (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (names.length === 0) return new Set(TOOL_GROUPS);
  const groups = new Set<string>(["info"]);
  for (const name of names) {
    const profile = TOOL_PROFILES[name];
    if (profile) {
      for (const g of profile) groups.add(g);
    } else if (TOOL_GROUPS.includes(name)) {
      groups.add(name);
    } else {
      throw new Error(
        `MCPFABRIC_TOOLSETS: unknown tool set "${name}". Profiles: ${Object.keys(TOOL_PROFILES).join(", ")}; groups: ${TOOL_GROUPS.join(", ")}`,
      );
    }
  }
  return groups;
}

// A name must mean one thing: a profile and a group with the same name would be ambiguous.
for (const name of Object.keys(TOOL_PROFILES)) {
  if (TOOL_GROUPS.includes(name)) throw new Error(`tool profile "${name}" clashes with a tool group`);
}
