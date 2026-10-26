// packaging.test.js — the published package declares the openclaw extension
// at its root so `openclaw plugins install @igorjpimenta/winch` registers it
// like any other npm-distributed plugin. The root manifest delegates to the
// adapter under plugins/openclaw/winch (the adapter stays a self-contained,
// testable unit; the root only points at it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const ADAPTER_ENTRY = "./plugins/openclaw/winch/index.js";

test("root package declares the openclaw extension surface", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(pkg.openclaw?.extensions, [ADAPTER_ENTRY]);
  assert.ok(pkg.files.includes("openclaw.plugin.json"), "root manifest ships in the tarball");
});

test("root manifest points at the adapter and declares configSchema", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "openclaw.plugin.json"), "utf8"));
  assert.equal(manifest.id, "winch");
  assert.deepEqual(manifest.extensions, [ADAPTER_ENTRY]);
  assert.ok(existsSync(path.join(root, ADAPTER_ENTRY)), "adapter entry exists");
  assert.equal(manifest.configSchema?.type, "object");
});

test("the openclaw adapter keeps its own manifest and id", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "plugins/openclaw/winch/openclaw.plugin.json"), "utf8")
  );
  assert.equal(manifest.id, "winch");
});
