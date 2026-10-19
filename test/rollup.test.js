// rollup.test.js — S3.3: dispatch fraction + cross-DB epic token rollup.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../src/store.js";
import { dispatchFraction, epicTokenRollup } from "../src/rollup.js";

let dir, store, opsPath;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "backlog-rollup-"));
  store = createStore({ dbPath: path.join(dir, "store.sqlite") });
  opsPath = path.join(dir, "ops.sqlite");
  const ops = new DatabaseSync(opsPath);
  ops.exec(`
    CREATE TABLE cost_by_call (
      session_key TEXT, ts INTEGER, total_tokens INTEGER, cost_total REAL
    );
    INSERT INTO cost_by_call VALUES
      ('agent:atlas:s1', 1000, 100, 0.01),
      ('agent:atlas:s1', 2000, 200, 0.02),
      ('agent:forge:s2', 3000, 50, 0.005);
  `);
  ops.close();
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

test("epic token rollup joins claim sessions to cost_by_call, flags shared sessions", () => {
  const a = claim("agent:atlas:s1");  // epic A: session atlas (2 calls, 300 tok, $0.03)
  claim("agent:forge:s2", { epic: a.epic }); // epic A, second session (1 call, 50 tok, $0.005)
  // epic B shares the forge session → shared
  const epicB = store.epic.create({ title: "E-B", status: "planned" });
  const storyB = store.story.create({ epicId: epicB.id, title: "SB", status: "ready" });
  const taskB = store.task.create({ storyId: storyB.id, title: "TB", executionKind: "manual" });
  store.task.claim({ id: taskB.id, agentId: "y", sessionKey: "agent:forge:s2" });

  const r = epicTokenRollup(store, { opsDbPath: opsPath });
  const epicA = r.epics.find((e) => e.epicId === a.epic.id);
  const foundB = r.epics.find((e) => e.epicId === epicB.id);
  assert.ok(epicA && foundB);
  assert.equal(epicA.sessions, 2);
  assert.equal(epicA.calls, 3);
  assert.equal(epicA.tokens, 350);
  assert.ok(Math.abs(epicA.costUsd - 0.035) < 1e-9);
  assert.equal(foundB.sessions, 1);
  assert.equal(foundB.tokens, 50);
  assert.ok(epicA.sharedWithOtherEpics, "forge session touched both epics");
  assert.deepEqual(r.sharedSessions, ["agent:forge:s2"]);
  assert.equal(r.totals.sessions, 3);
});

test("rollup skips epics with no claims in window", () => {
  claim("agent:atlas:s1");
  const r = epicTokenRollup(store, { opsDbPath: opsPath, windowMs: -60_000 }); // claims fall outside
  assert.equal(r.epics.length, 0);
  assert.deepEqual(r.sharedSessions, []);
});
