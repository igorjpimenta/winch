// cli.test.js — serve --mcp stdio takes no identity flags: the harness is
// env-only and agent/session arrive per call via the companion plugin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import path from "node:path";

const root = path.join(import.meta.dirname, "..", "..", "..");
const execFileAsync = promisify(execFile);

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

function runDbWithEnv(dbPath, env, ...args) {
  return spawnSync(process.execPath, [path.join(root, "bin/winch.js"), ...args], {
    encoding: "utf8",
    env: { ...process.env, WINCH_DB: dbPath, ...env },
  });
}

function runDbAsync(dbPath, ...args) {
  return execFileAsync(process.execPath, [path.join(root, "bin/winch.js"), ...args], {
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

test("webhook list/revoke round-trips an endpoint, secrets masked", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { createStore } = await import("../../../src/store/index.js");
  const dir = mkdtempSync(path.join(tmpdir(), "winch-cli-"));
  const db = path.join(dir, "store.sqlite");
  try {
    const store = createStore({ dbPath: db });
    store.webhook.upsert({ harness: "openclaw", executorId: "exec-1", url: "http://gw/wake", bearer: "s3cret" });
    store.close();

    let r = runDb(db, "webhook", "list");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /openclaw/);
    assert.match(r.stdout, /exec-1/);
    assert.doesNotMatch(r.stdout, /s3cret/);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, "http://gw/wake");
    assert.equal(rows[0].bearer, "<set>");

    r = runDb(db, "webhook", "revoke", "--harness", "openclaw", "--id", "exec-1");
    assert.equal(r.status, 0);
    r = runDb(db, "webhook", "list");
    assert.deepEqual(JSON.parse(r.stdout), []);
    r = runDb(db, "webhook", "revoke", "--harness", "openclaw", "--id", "exec-1");
    assert.equal(r.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("webhook revoke requires both harness and id", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "winch-cli-"));
  const db = path.join(dir, "store.sqlite");
  try {
    let r = runDb(db, "webhook", "list");
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), []);
    r = runDb(db, "webhook", "revoke", "--harness", "oc");
    assert.equal(r.status, 2);
    r = runDb(db, "webhook", "revoke", "--harness", "oc", "--id", "missing");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no webhook endpoint/);
    r = runDb(db, "dispatch", "list");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown command/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("webhook register creates a manual endpoint and generates a bearer", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "winch-cli-"));
  const db = path.join(dir, "store.sqlite");
  try {
    let r = runDb(db, "webhook", "register", "--harness", "myapp", "--url", "http://127.0.0.1:9/wake");
    assert.equal(r.status, 0);
    const created = JSON.parse(r.stdout);
    assert.equal(created.harness, "myapp");
    assert.match(created.id, /^manual-[0-9a-f]{12}$/);
    assert.match(created.bearer, /^[0-9a-f]{64}$/);

    r = runDb(db, "webhook", "register", "--harness", "myapp", "--id", "e1", "--url", "http://127.0.0.1:9/wake", "--bearer", "s3cret");
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).bearer, "<set>");

    r = runDb(db, "webhook", "list", "--harness", "myapp");
    const rows = JSON.parse(r.stdout);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.id === "e1").bearer, "<set>");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("webhook test pings each endpoint with its bearer", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "winch-cli-"));
  const db = path.join(dir, "store.sqlite");
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, test: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/wake`;
    let r = runDb(db, "webhook", "register", "--harness", "myapp", "--id", "e1", "--url", url, "--bearer", "s3cret");
    assert.equal(r.status, 0);

    const result = await runDbAsync(db, "webhook", "test", "--harness", "myapp");
    const rows = JSON.parse(result.stdout);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ok, true);
    assert.equal(rows[0].status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].auth, "Bearer s3cret");
    assert.deepEqual(seen[0].body, { type: "ping", harness: "myapp", executorId: "e1", at: seen[0].body.at });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("webhook bearer prints a token without touching the store", () => {
  const r = run("webhook", "bearer");
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^[0-9a-f]{64}$/);
});

test("webhook register uses WINCH_DISPATCH_BEARER when --bearer is absent", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "winch-cli-"));
  const db = path.join(dir, "store.sqlite");
  try {
    const r = runDbWithEnv(db, { WINCH_DISPATCH_BEARER: "env-secret" }, "webhook", "register", "--harness", "myapp", "--id", "e-env", "--url", "http://127.0.0.1:9/wake");
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).bearer, "<set>");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
