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

// The adapter ships as its own npm package (@igorjpimenta/winch-openclaw), so
// the plugin manifest lives at THAT package's root — the core package stays
// harness-free. `openclaw plugins install` reads these two fields.
test("the adapter is publishable as its own openclaw plugin package", () => {
  const dir = path.join(root, "plugins/openclaw/winch");
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.name, "@igorjpimenta/winch-openclaw");
  assert.deepEqual(pkg.openclaw?.extensions, ["./index.js"]);
  assert.ok(pkg.files.includes("openclaw.plugin.json"), "plugin manifest ships in the tarball");
  assert.ok(existsSync(path.join(dir, "openclaw.plugin.json")));
  assert.equal(pkg.private, undefined, "publishable, not a private workspace package");
});

// Omitting onStartup no longer startup-loads a plugin: without it the host
// skips register(), so the claim route and services never bind.
test("the adapter opts into startup activation", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "plugins/openclaw/winch/openclaw.plugin.json"), "utf8")
  );
  assert.equal(manifest.activation?.onStartup, true);
});
