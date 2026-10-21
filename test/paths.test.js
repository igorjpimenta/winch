// paths.test.js — the store path belongs to winch, not to a harness. The old
// openclaw path is not read implicitly; moving it is an explicit command.
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

test("BACKLOG_DB_PATH remains an explicit override", (t) => {
  const home = tempHome(t);
  assert.equal(
    resolveDbPath({ home, env: { BACKLOG_DB_PATH: "/tmp/legacy-env.sqlite" } }),
    "/tmp/legacy-env.sqlite"
  );
});

test("a fresh home resolves to ~/.winch/store.sqlite", (t) => {
  const home = tempHome(t);
  assert.equal(resolveDbPath({ home, env: {} }), defaultDbPath(home));
});

test("an existing legacy store does not change the default", (t) => {
  const home = tempHome(t);
  touch(legacyDbPath(home));
  assert.equal(resolveDbPath({ home, env: {} }), defaultDbPath(home));
});

test("the legacy path is still available to the explicit migration command", (t) => {
  const home = tempHome(t);
  assert.equal(legacyDbPath(home), path.join(home, ".openclaw", "backlog", "store.sqlite"));
});
