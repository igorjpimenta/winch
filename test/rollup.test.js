// rollup.test.js — S3.3: dispatch fraction from store rows only.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";
import { dispatchFraction } from "../src/rollup.js";

let dir, store;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "backlog-rollup-"));
  store = await createStore({ dbPath: path.join(dir, "store.sqlite") });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function claim(sessionKey, { epic: existingEpic } = {}) {
  const epic = existingEpic ?? store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  const task = store.task.create({ storyId: story.id, title: "T", executionKind: "manual" });
  const r = store.task.claim({ id: task.id, agentId: "x", sessionKey });
  assert.ok(r, "claim must win");
  return { epic, task };
}

test("claim events carry session_ref end-to-end", () => {
  claim("agent:atlas:s1");
  const ev = store.db.prepare("SELECT session_ref FROM events WHERE note='claim'").get();
  assert.equal(ev.session_ref, "agent:atlas:s1");
});

test("dispatch fraction separates self-dispatched from operator-CLI claims", () => {
  claim("agent:atlas:s1");           // tool/session claim
  claim("agent:scout:s3");           // tool/session claim
  // operator-style claim: event without a session (CLI path writes none)
  const e2 = store.epic.create({ title: "E2", status: "planned" });
  const s2 = store.story.create({ epicId: e2.id, title: "S2", status: "ready" });
  const t2 = store.task.create({ storyId: s2.id, title: "T2", executionKind: "manual" });
  store.task.claim({ id: t2.id, agentId: "builder" });
  store.db.prepare("UPDATE events SET session_ref=NULL WHERE task_id=?").run(t2.id);

  const d = dispatchFraction(store);
  assert.equal(d.total, 3);
  assert.equal(d.selfDispatched, 2);
  assert.equal(d.operatorDispatched, 1);
  assert.ok(Math.abs(d.fraction - 2 / 3) < 1e-9);
});

test("dispatch fraction ignores claims outside the window", () => {
  claim("agent:atlas:s1");
  const d = dispatchFraction(store, { windowMs: -60_000 }); // claim falls outside
  assert.equal(d.total, 0);
  assert.equal(d.fraction, 0);
});
