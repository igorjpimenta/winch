// paths.test.js — the store path belongs to winch, not to a harness. There is
// no implicit legacy path; moving a store is an explicit command.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultDbPath, resolveDbPath } from "../../src/paths.js";

function tempHome(t) {
  const home = mkdtempSync(path.join(tmpdir(), "winch-paths-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function touch(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "");
}

test("WINCH_DB wins over the default path", (t) => {
  const home = tempHome(t);
  touch(defaultDbPath(home));
  assert.equal(resolveDbPath({ home, env: { WINCH_DB: "/tmp/explicit.sqlite" } }), "/tmp/explicit.sqlite");
});

test("BACKLOG_DB_PATH no longer overrides the default", (t) => {
  const home = tempHome(t);
  assert.equal(
    resolveDbPath({ home, env: { BACKLOG_DB_PATH: "/tmp/legacy-env.sqlite" } }),
    defaultDbPath(home)
  );
});

test("a fresh home resolves to ~/.winch/store.sqlite", (t) => {
  const home = tempHome(t);
  assert.equal(resolveDbPath({ home, env: {} }), defaultDbPath(home));
});
