/**
 * The dashboard view: one self-contained HTML page that MCP Apps hosts render in a sandboxed iframe.
 * It talks to the server only through the host (the ext-apps `App` class, inlined below), refreshes
 * itself with the app-only `dashboard_state` tool, and its STOP button calls `dashboard_stop`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/**
 * The ext-apps browser bundle as a classic script: its trailing `export{a as B,...}` becomes
 * `window.__mcpApps={B:a,...}`, so the page needs no module loading (hosts restrict it).
 */
function appBundle(): string {
  const path = fileURLToPath(import.meta.resolve("@modelcontextprotocol/ext-apps/app-with-deps"));
  const code = readFileSync(path, "utf8");
  const match = /export\s*\{([^}]*)\};?\s*$/.exec(code);
  if (!match) throw new Error("unexpected ext-apps bundle format: no trailing export list");
  const pairs = match[1]!
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [local, exported] = s.split(/\s+as\s+/);
      return `${JSON.stringify(exported ?? local)}:${local}`;
    });
  // Wrapped in a function so the bundle's top-level names stay out of the page's global scope.
  return `(function(){${code.slice(0, match.index)}\nwindow.__mcpApps={${pairs.join(",")}};})();`;
}

const STYLE = `
:root{--bg:#f6f5f2;--fg:#1d1c1a;--muted:#6b6862;--card:#fff;--line:#e3e0da;--accent:#3a7d44;--warn:#b5651d;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe8;--muted:#9c9890;--card:#1f1f1c;--line:#33322e;--accent:#6cbf73;--warn:#e0a060;--bad:#f2766b}}
*{box-sizing:border-box}body{margin:0;padding:12px;background:var(--bg);color:var(--fg);font:13px/1.4 system-ui,sans-serif}
header{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
h1{font-size:15px;margin:0;flex:1}
#stop{background:var(--bad);color:#fff;border:0;border-radius:6px;padding:6px 14px;font-weight:600;cursor:pointer}
#stop:disabled{opacity:.5;cursor:default}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;min-width:0}
.card h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 6px}
.bar{height:6px;border-radius:3px;background:var(--line);overflow:hidden;margin:3px 0 8px}.bar>i{display:block;height:100%}
pre{margin:0;font:12px/1.15 ui-monospace,Consolas,monospace;overflow-x:auto}
.legend{color:var(--muted);font-size:11px;margin-top:6px}
ul{list-style:none;margin:0;padding:0}li{padding:2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.next{font-weight:600;color:var(--accent)}.done{color:var(--muted);text-decoration:line-through}
.inv{display:flex;flex-wrap:wrap;gap:4px}.inv span{border:1px solid var(--line);border-radius:4px;padding:1px 5px;font-size:12px}
#state{color:var(--muted);font-size:12px}.paused{color:var(--warn);font-weight:600}
`;

const SCRIPT = `
const { App } = window.__mcpApps;
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; return e; };
const bar = (id, value, max, color) => { const i = $(id); i.style.width = Math.max(0, Math.min(100, (100 * value) / max)) + "%"; i.style.background = color; };

function render(s) {
  if (!s || !s.at) return;
  $("where").textContent = s.at.x + " " + s.at.y + " " + s.at.z + " · " + s.at.dim.replace("minecraft:", "") + " · " + s.gameMode;
  $("hp").textContent = "health " + s.health.toFixed(0) + "/" + s.maxHealth.toFixed(0);
  bar("hpbar", s.health, s.maxHealth || 20, "var(--bad)");
  $("food").textContent = "food " + s.food + "/20";
  bar("foodbar", s.food, 20, "var(--warn)");
  const state = $("state");
  state.textContent = s.aiPaused ? "paused by the player" : "updated " + new Date(s.takenAt).toLocaleTimeString();
  state.className = s.aiPaused ? "paused" : "";
  $("job").textContent = s.job || "no job running";
  $("map").textContent = s.map.rows.join("\\n");
  $("legend").textContent = s.map.legend;
  const goals = $("goals"); goals.replaceChildren();
  if (s.goals.length === 0) goals.append(el("li", "no goals yet"));
  for (const g of s.goals) {
    const li = el("li", "\\u00a0\\u00a0".repeat(g.depth) + "#" + g.id + " " + g.title, g.next ? "next" : g.status === "done" ? "done" : "");
    li.title = g.title + " (" + g.status + ")";
    goals.append(li);
  }
  const inv = $("inv"); inv.replaceChildren();
  if (s.inventory.length === 0) inv.append(el("span", "empty"));
  for (const it of s.inventory) inv.append(el("span", it.count + " " + it.id));
}

const app = new App({ name: "mcpfabric-dashboard", version: "1.0.0" });
app.ontoolresult = (p) => render(p.structuredContent);
let busy = false;
async function refresh() {
  if (busy || document.hidden) return;
  busy = true;
  try { render((await app.callServerTool({ name: "dashboard_state", arguments: {} })).structuredContent); }
  catch (e) { $("state").textContent = "game not reachable"; }
  finally { busy = false; }
}
$("stop").onclick = async () => {
  const b = $("stop"); b.disabled = true; b.textContent = "Stopping…";
  try {
    const r = await app.callServerTool({ name: "dashboard_stop", arguments: {} });
    $("state").textContent = (r.content && r.content[0] && r.content[0].text) || "stopped";
  } finally { b.disabled = false; b.textContent = "STOP"; }
};
app.connect().then(() => { refresh(); setInterval(refresh, 3000); });
`;

export function dashboardHtml(): string {
  cached ??= `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent dashboard</title><style>${STYLE}</style></head><body>
<header><h1>Minecraft agent</h1><span id="state">connecting…</span><button id="stop" title="Cancel the job and stop moving, mining and supervised input">STOP</button></header>
<div class="grid">
<section class="card"><h2>Player</h2><div id="where">…</div><div id="hp" style="margin-top:6px">health</div><div class="bar"><i id="hpbar"></i></div><div id="food">food</div><div class="bar"><i id="foodbar"></i></div><h2>Job</h2><pre id="job">…</pre></section>
<section class="card"><h2>Map (1 char = 1 chunk, north up)</h2><pre id="map"></pre><div class="legend" id="legend"></div></section>
<section class="card"><h2>Goals</h2><ul id="goals"></ul></section>
<section class="card"><h2>Inventory</h2><div class="inv" id="inv"></div></section>
</div>
<script>${appBundle()}</script><script>${SCRIPT}</script></body></html>`;
  return cached;
}
