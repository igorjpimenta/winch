// paths.test.js — the store path belongs to winch, not to a harness. The
// legacy openclaw path stays readable until it is migrated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultDbPath, legacyDbPath, resolveDbPath } from "../src/paths.js";

function tempHome(t) {
  const home = mkdtempSync(path.join(tmpdir(), "winch-paths-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function touch(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "");
}

test("WINCH_DB wins over both the default and the legacy path", (t) => {
  const home = tempHome(t);
  touch(defaultDbPath(home));
  assert.equal(resolveDbPath({ home, env: { WINCH_DB: "/tmp/explicit.sqlite" } }), "/tmp/explicit.sqlite");
});

test("BACKLOG_DB_PATH remains the legacy explicit override", (t) => {
  const home = tempHome(t);
  assert.equal(
    resolveDbPath({ home, env: { BACKLOG_DB_PATH: "/tmp/legacy-env.sqlite" } }),
    "/tmp/legacy-env.sqlite"
  );
});

test("a fresh home resolves to ~/.winch/store.sqlite", (t) => {
  const home = tempHome(t);
  assert.equal(resolveDbPath({ home, env: {}, warn: () => {} }), defaultDbPath(home));
});

test("a legacy-only home keeps reading the old store and warns once", (t) => {
  const home = tempHome(t);
  touch(legacyDbPath(home));
  const warnings = [];
  const resolved = resolveDbPath({ home, env: {}, warn: (m) => warnings.push(m) });
  assert.equal(resolved, legacyDbPath(home));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /winch migrate-store/);
});

test("the new path wins once it exists, so migration is a one-time decision", (t) => {
  const home = tempHome(t);
  touch(defaultDbPath(home));
  touch(legacyDbPath(home));
  const warnings = [];
  assert.equal(resolveDbPath({ home, env: {}, warn: (m) => warnings.push(m) }), defaultDbPath(home));
  assert.deepEqual(warnings, []);
});
