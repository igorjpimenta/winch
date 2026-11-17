// cli.test.js — serve --mcp stdio takes no identity flags: the harness is
// env-only and agent/session arrive per call via the companion plugin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.join(import.meta.dirname, "..", "..");

function run(...args) {
  return spawnSync(process.execPath, [path.join(root, "bin/winch.js"), ...args], {
    encoding: "utf8",
  });
}

function runDb(dbPath, ...args) {
  return spawnSync(process.execPath, [path.join(root, "bin/winch.js"), ...args], {
    encoding: "utf8",
    env: { ...process.env, WINCH_DB: dbPath },
  });
}

test("serve --mcp stdio rejects --harness (env-only)", () => {
  const r = run("serve", "--mcp", "stdio", "--harness", "test");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /takes no --harness flag/);
});

test("serve --mcp rejects unknown transports", () => {
  const r = run("serve", "--mcp", "sse");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /must be stdio or http/);
});

test("serve requires exactly one mode", () => {
  const r = run("serve", "--ws", "--mcp", "stdio");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: winch serve/);
});

test("removed mcp command is unknown", () => {
  const r = run("mcp", "--harness", "test");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command/);
});

test("dispatch list/remove round-trips an executor target, secrets masked", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { createStore } = await import("../../src/store/index.js");
  const dir = mkdtempSync(path.join(tmpdir(), "winch-cli-"));
  const db = path.join(dir, "store.sqlite");
  try {
    const store = createStore({ dbPath: db });
    store.dispatch.upsert({ harness: "openclaw", executorId: "exec-1", url: "http://gw/wake", bearer: "s3cret" });
    store.close();

    let r = runDb(db, "dispatch", "list");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /openclaw/);
    assert.match(r.stdout, /exec-1/);
    assert.doesNotMatch(r.stdout, /s3cret/);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, "http://gw/wake");
    assert.equal(rows[0].bearer, "<set>");

    r = runDb(db, "dispatch", "remove", "--harness", "openclaw", "--executor", "exec-1");
    assert.equal(r.status, 0);
    r = runDb(db, "dispatch", "list");
    assert.deepEqual(JSON.parse(r.stdout), []);
    r = runDb(db, "dispatch", "remove", "--harness", "openclaw", "--executor", "exec-1");
    assert.equal(r.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch remove requires both harness and executor", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "winch-cli-"));
  const db = path.join(dir, "store.sqlite");
  try {
    let r = runDb(db, "dispatch", "list");
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), []);
    r = runDb(db, "dispatch", "remove", "--harness", "oc");
    assert.equal(r.status, 2);
    r = runDb(db, "dispatch", "remove", "--harness", "oc", "--executor", "missing");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no dispatch endpoint/);
    r = runDb(db, "webhook", "list");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown command/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
