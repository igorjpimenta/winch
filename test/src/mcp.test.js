// mcp.test.js — server construction refuses an undeclared or poisoned
// harness before connecting. (A harness-only base is accepted up to the
// transport, so only rejection paths are unit-tested here.)
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../../src/store.js";
import { startMcpServer, toolErrorResult } from "../../src/mcp.js";

let dir, store;

afterEach(() => {
  if (store) store.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = store = undefined;
});

function freshStore() {
  dir = mkdtempSync(path.join(tmpdir(), "backlog-mcp-"));
  store = createStore({ dbPath: path.join(dir, "store.sqlite") });
  return store;
}

test("startMcpServer rejects a missing harness before connecting", async () => {
  await assert.rejects(
    () => startMcpServer({ store: freshStore(), base: { agent: "a", session: "s" } }),
    /missing: harness/
  );
});

test("startMcpServer rejects a reserved harness before connecting", async () => {
  await assert.rejects(
    () => startMcpServer({ store: freshStore(), base: { harness: "unknown" } }),
    /refused declaration/
  );
});

test("toolErrorResult: unexpected failures become isError tool results", () => {
  const r = toolErrorResult(new Error("winch: refused caller identity for backlog_next (bad layers: agent)"));
  assert.equal(r.isError, true);
  const body = JSON.parse(r.content[0].text);
  assert.match(body.error, /refused caller identity/);
});
