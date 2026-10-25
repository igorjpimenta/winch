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
