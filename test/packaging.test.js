// packaging.test.js — the repo root is an MCP server package, not an
// openclaw extension. A clone under a harness's extension directory must not
// be auto-discovered as a second winch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");

test("root package does not declare a harness extension surface", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.openclaw, undefined);
  assert.equal(existsSync(path.join(root, "openclaw.plugin.json")), false);
});

test("the openclaw adapter keeps its own manifest and id", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "plugins/openclaw/winch/openclaw.plugin.json"), "utf8")
  );
  assert.equal(manifest.id, "winch");
});
