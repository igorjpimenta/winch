// packaging.test.js — the repo root is an MCP server package, not an
// openclaw extension. A clone under ~/.openclaw/extensions must not be
// auto-discovered (it would register winch-meta a second time).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");

test("root package does not declare an openclaw extension surface", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.openclaw, undefined);
  assert.equal(existsSync(path.join(root, "openclaw.plugin.json")), false);
});

test("the companion hook keeps its own manifest and id", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "plugins/openclaw/winch-meta/openclaw.plugin.json"), "utf8")
  );
  assert.equal(manifest.id, "winch-meta");
});
