// cli.test.js — serve --mcp stdio takes no identity flags: the harness is
// env-only and agent/session arrive per call via the companion plugin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");

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

test("webhook set/list/remove round-trips a target, secrets masked", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "winch-cli-"));
  const db = path.join(dir, "store.sqlite");
  try {
    let r = runDb(db, "webhook", "set", "--harness", "openclaw", "--url", "http://gw/hook", "--bearer", "s3cret");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /openclaw/);
    assert.doesNotMatch(r.stdout, /s3cret/);
    r = runDb(db, "webhook", "list");
    assert.equal(r.status, 0);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, "http://gw/hook");
    r = runDb(db, "webhook", "remove", "--harness", "openclaw");
    assert.equal(r.status, 0);
    r = runDb(db, "webhook", "list");
    assert.deepEqual(JSON.parse(r.stdout), []);
    r = runDb(db, "webhook", "remove", "--harness", "openclaw");
    assert.equal(r.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("webhook set refuses bad urls, test fails fast with no target", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "winch-cli-"));
  const db = path.join(dir, "store.sqlite");
  try {
    let r = runDb(db, "webhook", "set", "--harness", "oc", "--url", "ftp://x/y");
    assert.equal(r.status, 1);
    r = runDb(db, "webhook", "set", "--harness", "oc");
    assert.equal(r.status, 2);
    r = runDb(db, "webhook", "test", "--harness", "nobody");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no webhook target/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
