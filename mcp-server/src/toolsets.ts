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

/** Every group a tool can belong to; `agent` holds the agent runtime tools, `script` run_script and the skills. */
export const TOOL_GROUPS = [...new Set([...Object.values(METHOD_GROUPS), "agent", "script"])].sort();

/**
 * Not a group but a filter: with it, only tools whose readOnlyHint is true are served (pair it with
 * the mod's `readToken`, which may only call those).
 */
export const READONLY = "readonly";

/**
 * Not a group but a filter for small models: only {@link COMPACT_TOOLS} are served, with short
 * descriptions, and run_script and the dashboard are left out. It shrinks what the model reads
 * before its first turn from about 16 000 tokens to a few thousand.
 */
export const COMPACT = "compact";

/**
 * The tools a small model gets: high-level jobs and memory rather than many low-level steps, plus
 * the few direct actions they cannot do without. A tool whose group is not served stays out.
 */
export const COMPACT_TOOLS: ReadonlySet<string> = new Set([
  "get_status",
  "agent_brief",
  "observe",
  "surroundings",
  "get_self",
  "get_inventory",
  "get_screen",
  "close_screen",
  "get_recent_chat",
  "send_chat",
  "show_message",
  "travel_to",
  "collect_blocks",
  "craft_item",
  "plan_craft",
  "job_status",
  "job_cancel",
  "stop_movement",
  "break_block",
  "place_block_at",
  "use_item",
  "select_hotbar_slot",
  "attack_entity",
  "open_container",
  "container_transfer",
  "close_container",
  "remember",
  "recall",
  "goal_add",
  "goal_update",
  "goal_list",
]);

/** Most characters of a description in compact mode. */
export const COMPACT_DESCRIPTION_CHARS = 200;

/** Whether this tool is served for these groups when compact mode is on (true when it is off). */
export function servesCompact(groups: Set<string>, name: string): boolean {
  return !groups.has(COMPACT) || COMPACT_TOOLS.has(name);
}

/**
 * The description a model gets: in compact mode the first sentence, joined with the next one when
 * the first is only a label ("Client-only."), cut at a word near {@link COMPACT_DESCRIPTION_CHARS}.
 */
export function describeFor(groups: Set<string>, description: string): string {
  if (!groups.has(COMPACT)) return description;
  // A sentence ends at . ! or ? followed by a space, so "1.21.1" and "e.g." inside words stay whole.
  const sentences = description.trim().split(/(?<!\b(?:e\.g|i\.e)\.)(?<=[.!?])\s+/);
  let out = (sentences[0] ?? "").trim();
  for (let i = 1; i < sentences.length && out.length < 40; i++) out = `${out} ${sentences[i]!.trim()}`;
  if (out.length <= COMPACT_DESCRIPTION_CHARS) return out;
  const cut = out.slice(0, COMPACT_DESCRIPTION_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > 80 ? cut.slice(0, space) : cut}…`;
}

/** Whether a tool with these hints is served for these groups (the group itself is checked apart). */
export function servesHints(groups: Set<string>, annotations: { readOnlyHint: boolean }): boolean {
  return !groups.has(READONLY) || annotations.readOnlyHint;
}

/** Named profiles, each a union of groups. */
export const TOOL_PROFILES: Record<string, readonly string[]> = {
  all: TOOL_GROUPS,
  play: ["info", "player", "vision", "chat", "events", "session", "agent", "script"],
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
  let names = (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  // `readonly` and `compact` are filters on top of the other names.
  const filters = [READONLY, COMPACT].filter((f) => names.includes(f));
  names = names.filter((n) => !filters.includes(n));
  if (names.length === 0) return new Set([...TOOL_GROUPS, ...filters]);
  const groups = new Set<string>(["info"]);
  for (const name of names) {
    const profile = TOOL_PROFILES[name];
    if (profile) {
      for (const g of profile) groups.add(g);
    } else if (TOOL_GROUPS.includes(name)) {
      groups.add(name);
    } else {
      throw new Error(
        `MCPFABRIC_TOOLSETS: unknown tool set "${name}". Profiles: ${Object.keys(TOOL_PROFILES).join(", ")}; groups: ${TOOL_GROUPS.join(", ")}; filters: ${READONLY}, ${COMPACT}`,
      );
    }
  }
  for (const f of filters) groups.add(f);
  return groups;
}

// A name must mean one thing: a profile and a group with the same name would be ambiguous.
for (const name of Object.keys(TOOL_PROFILES)) {
  if (TOOL_GROUPS.includes(name)) throw new Error(`tool profile "${name}" clashes with a tool group`);
}
