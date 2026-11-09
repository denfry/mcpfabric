import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("npx <package name> resolves to the MCP server", () => {
  // With several bins, npx only runs the one named after the package.
  assert.equal(pkg.bin[pkg.name], pkg.main);
});
