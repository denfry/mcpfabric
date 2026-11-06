// Builds dist/mcpfabric-<version>.mcpb, a one-click install for Claude Desktop: the compiled
// server, its production dependencies and manifest.json, packed with the official mcpb CLI.
// Usage: npm run bundle (needs network access for npm and the CLI).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const stage = join(root, ".mcpb-stage");
const out = join(root, "dist-mcpb", `mcpfabric-${pkg.version}.mcpb`);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
// npm and npx are .cmd scripts on Windows, which only run through a shell.
const run = (cmd, args, cwd) =>
  process.platform === "win32"
    ? execFileSync([cmd, ...args.map((a) => `"${a}"`)].join(" "), { cwd, stdio: "inherit", shell: true })
    : execFileSync(cmd, args, { cwd, stdio: "inherit" });

run(npm, ["run", "build"], root);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, "dist"), join(stage, "server"), { recursive: true });
// dist/index.js reads ../package.json for its version; npm ci needs the lock file to match it.
cpSync(join(root, "package.json"), join(stage, "package.json"));
cpSync(join(root, "package-lock.json"), join(stage, "package-lock.json"));
cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));
const icon = join(root, "..", "docs", "assets", "mcpfabric-icon-512.png");
if (existsSync(icon)) cpSync(icon, join(stage, "icon.png"));
const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));
manifest.version = pkg.version;
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));
run(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
mkdirSync(dirname(out), { recursive: true });
run(npx, ["-y", "@anthropic-ai/mcpb@2", "pack", stage, out], root);
rmSync(stage, { recursive: true, force: true });
console.log(`wrote ${out}`);
