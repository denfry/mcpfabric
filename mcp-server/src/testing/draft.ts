/**
 * Turns the steps recorded by the mod (recorder.stop) into a draft `*.mctest.js`: one test that walks
 * the same waypoints, breaks and places the same blocks, opens the same containers and says the same
 * chat, then checks that the inventory ends as it did. It is a draft: entity targets and clicks
 * inside menus cannot be replayed from a recording, and those spots are left as comments.
 */

export interface RecordedStep {
  kind: string;
  t?: number;
  [key: string]: unknown;
}

export interface DraftOptions {
  /** The test's name. */
  name?: string;
}

type Pos = { x: number; y: number; z: number };

const str = (v: unknown): string => JSON.stringify(String(v ?? ""));
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const pos = (s: RecordedStep): Pos => ({ x: Math.trunc(num(s.x)), y: Math.trunc(num(s.y)), z: Math.trunc(num(s.z)) });
const at = (p: Pos): string => `{ x: ${p.x}, y: ${p.y}, z: ${p.z} }`;
/** Text from the game in a comment: one line, no comment terminator. */
const note = (v: unknown): string => String(v ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\*\//g, "* /").slice(0, 200);

function counts(v: unknown): Map<string, number> {
  const m = new Map<string, number>();
  if (v && typeof v === "object") {
    for (const [id, n] of Object.entries(v as Record<string, unknown>)) if (typeof n === "number") m.set(id, n);
  }
  return m;
}

/** The test file for the recorded steps. */
export function draftTest(steps: RecordedStep[], opts: DraftOptions = {}): string {
  const name = opts.name?.trim() || "recorded run";
  const body: string[] = [];
  const emit = (line: string): void => {
    body.push(line ? "  " + line : "");
  };
  let start: Map<string, number> | undefined;
  let end: Map<string, number> | undefined;
  let last = "";

  for (const s of steps) {
    switch (s.kind) {
      case "start": {
        start = counts(s.inventory);
        const items = [...start].map(([id, n]) => `${n} ${id.replace(/^minecraft:/, "")}`).join(", ");
        emit(`// Recorded in ${note(s.dimension)}. The inventory held: ${items || "nothing"}.`);
        emit(`// Give the player the same items first (beforeEach with command("give @p ...")) so the run can repeat.`);
        emit(`await goTo(${at(pos(s))});`);
        if (typeof s.slot === "number") emit(`await mc.select_hotbar_slot({ slot: ${s.slot} }); // ${note(s.held)}`);
        break;
      }
      case "move":
        // Consecutive waypoints only need the last one when nothing happened in between.
        if (last === "move" && body.length > 0 && body[body.length - 1].includes("await goTo(")) body.pop();
        emit(`await goTo(${at(pos(s))});`);
        break;
      case "select":
        emit(`await mc.select_hotbar_slot({ slot: ${num(s.slot)} }); // ${note(s.item)}`);
        break;
      case "break":
        emit(`await mc.break_block(${at(pos(s))}); // ${note(s.block)}`);
        break;
      case "place":
        emit(`await mc.place_block_at({ ...${at(pos(s))}, state: ${str(s.state)} });`);
        break;
      case "use_block": {
        const p = pos(s);
        emit(`// ${note(s.from)} -> ${note(s.to)}`);
        emit(`await mc.look_at({ x: ${p.x + 0.5}, y: ${p.y + 0.5}, z: ${p.z + 0.5} });`);
        emit(`await mc.use_item({});`);
        break;
      }
      case "use_item":
        emit(`await mc.use_item({}); // ${note(s.item)}`);
        break;
      case "use_entity":
      case "attack": {
        const verb = s.kind === "attack" ? "attacked" : "used";
        const tool = s.kind === "attack" ? "attack_entity" : "use_entity";
        emit(`// The player ${verb} a ${note(s.type)} near ${at(pos(s))}. Entities differ between runs:`);
        emit(`// find it (query_entities on a server) and call mc.${tool}({ uuid }).`);
        break;
      }
      case "open_container":
        emit(`await mc.container_open(${at(pos(s))}); // ${note(s.block)}`);
        emit(`await waitForScreen("container");`);
        break;
      case "close_container": {
        const change = counts(s.inventoryChange);
        const took = [...change].filter(([, n]) => n > 0).map(([id, n]) => `${n} ${id}`);
        const put = [...change].filter(([, n]) => n < 0).map(([id, n]) => `${-n} ${id}`);
        if (took.length) emit(`// Taken out: ${took.join(", ")}.`);
        if (put.length) emit(`// Put in: ${put.join(", ")}.`);
        if (took.length || put.length) emit(`// Clicks inside menus are not recorded: move them with mc.container_click({ slot, mode }).`);
        emit(`await mc.container_close({});`);
        break;
      }
      case "chat":
        emit(`await mc.send_chat({ message: ${str(s.message)} });`);
        break;
      case "end":
        end = counts(s.inventory);
        break;
      default:
        emit(`// ${note(s.kind)} (not replayed)`);
    }
    last = s.kind;
  }

  if (start && end) {
    const ids = [...new Set([...start.keys(), ...end.keys()])].sort();
    const changed = ids.filter((id) => (start!.get(id) ?? 0) !== (end!.get(id) ?? 0));
    if (changed.length) {
      emit("");
      emit("// The inventory ended like this:");
      for (const id of changed) emit(`expect(await inventoryCount(${str(id)})).toBe(${end.get(id) ?? 0});`);
    }
  }

  return [
    "// Recorded with mcpfabric. A draft: read it, give the player the starting items, and add the checks that matter.",
    "",
    `test(${str(name)}, async () => {`,
    ...body,
    "});",
    "",
  ].join("\n");
}
