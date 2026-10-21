// migrate.test.js — copying a store is additive: the source stays
// readable and the target is a consistent snapshot, not a file move.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateStore } from "../src/migrate.js";

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "winch-migrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seed(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("seed", "42");
  db.close();
}

test("copies rows to the target and leaves the source intact", (t) => {
  const dir = tempDir(t);
  const from = path.join(dir, "source", "store.sqlite");
  const to = path.join(dir, "winch", "store.sqlite");
  seed(from);

  const result = migrateStore({ from, to });
  assert.deepEqual(result, { from, to });
  assert.equal(existsSync(from), true);

  const db = new DatabaseSync(to, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='seed'").get().value, "42");
  } finally {
    db.close();
  }
});

test("refuses to overwrite an existing target", (t) => {
  const dir = tempDir(t);
  const from = path.join(dir, "source.sqlite");
  const to = path.join(dir, "winch.sqlite");
  seed(from);
  writeFileSync(to, "do not clobber");

  assert.throws(() => migrateStore({ from, to }), /target already exists/);
  assert.equal(existsSync(from), true);
});

test("reports a missing source instead of creating an empty store", (t) => {
  const dir = tempDir(t);
  const from = path.join(dir, "missing.sqlite");
  const to = path.join(dir, "winch.sqlite");

  assert.throws(() => migrateStore({ from, to }), /source store not found/);
  assert.equal(existsSync(to), false);
});

test("requires an explicit source", (t) => {
  const dir = tempDir(t);
  assert.throws(() => migrateStore({ to: path.join(dir, "winch.sqlite") }), /source required/);
});
