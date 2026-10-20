// mcp.test.js — server construction refuses an incomplete identity
// declaration before any transport is opened.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";
import { startMcpServer, toolErrorResult } from "../src/mcp.js";

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

test("startMcpServer rejects a missing declaration before connecting", async () => {
  await assert.rejects(
    () => startMcpServer({ store: freshStore(), base: { harness: "langgraph" } }),
    /refused declaration \(bad layers: agent, session\)/
  );
});

test("startMcpServer rejects an empty base entirely", async () => {
  await assert.rejects(
    () => startMcpServer({ store: freshStore(), base: undefined }),
    /bad layers: harness, agent, session/
  );
});

test("toolErrorResult: unexpected failures become isError tool results", () => {
  const r = toolErrorResult(new Error("winch: refused caller identity for backlog_next (bad layers: agent)"));
  assert.equal(r.isError, true);
  const body = JSON.parse(r.content[0].text);
  assert.match(body.error, /refused caller identity/);
});
