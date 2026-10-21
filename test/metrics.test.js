// metrics.test.js — S3.2: MAST buckets from real store evidence + windowing.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";
import { failureReport, formatFailureReport } from "../src/metrics.js";

let dir, store, epic, story, task;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "backlog-metrics-"));
  store = createStore({ dbPath: path.join(dir, "store.sqlite") });
  epic = store.epic.create({ title: "E", status: "planned" });
  story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  task = store.task.create({ storyId: story.id, title: "T", executionKind: "manual" });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const note = (n, at) => store.db.prepare(
  "INSERT INTO events(task_id, from_status, to_status, actor, note, at) VALUES (?, 'todo', 'blocked', 'watcher', ?, ?)"
).run(task.id, n, at);

test("system_design: sweeper escalations land in the bucket", () => {
  const now = Date.now();
  note("blocked: max attempts", now - 1000);
  note("plain progress: fine", now - 2000); // not a failure
  const r = failureReport(store, { now });
  assert.equal(r.counts.system_design, 1);
  assert.equal(r.counts.misalignment, 0);
  assert.ok(r.unmapped.length === 1 && r.unmapped[0].includes("misalignment"));
});

test("verification: reworked tasks (attempt_count >= 2) in window only", () => {
  const now = Date.now();
  store.db.prepare("UPDATE tasks SET attempt_count=3, updated_at=? WHERE id=?").run(now - 500, task.id);
  const stale = store.task.create({ storyId: story.id, title: "old rework", executionKind: "manual" });
  store.db.prepare("UPDATE tasks SET attempt_count=5, updated_at=? WHERE id=?").run(now - 40 * 86_400_000, stale.id);
  const r = failureReport(store, { now });
  assert.equal(r.counts.verification, 1);
  assert.equal(r.verification[0].id, task.id);
  assert.equal(r.verification[0].attempts, 3);
});

test("window filters old system_design evidence", () => {
  const now = Date.now();
  note("blocked: max attempts", now - 40 * 86_400_000);
  const r = failureReport(store, { now, windowMs: 30 * 86_400_000 });
  assert.equal(r.counts.system_design, 0);
  const all = failureReport(store, { now, windowMs: 60 * 86_400_000 });
  assert.equal(all.counts.system_design, 1);
});

test("formatFailureReport renders counts and evidence lines", () => {
  note("blocked: max attempts", Date.now());
  const text = formatFailureReport(failureReport(store));
  assert.match(text, /system_design: 1/);
  assert.match(text, /misalignment:\s+0 \(unmapped/);
  assert.match(text, /\[system_design\] TASK-.* blocked: max attempts/);
});
