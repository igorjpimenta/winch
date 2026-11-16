// The mechanics the recursive model exists for: nested items, attempt
// history, generated columns, and ids that carry no kind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../../../src/store/index.js";

function makeStore(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "winch-items-"));
  const store = createStore({ dbPath: path.join(dir, "store.sqlite") });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

test("a task can split into subtasks without a schema change", (t) => {
  const store = makeStore(t);
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  const task = store.task.create({ storyId: story.id, title: "T" });
  const sub = store.task.create({ storyId: task.id, title: "sub" });
  assert.equal(store.item.get(sub.id).parent_id, task.id);
  assert.equal(store.item.get(sub.id).story_id, story.id);
  assert.equal(store.item.get(sub.id).epic_id, epic.id);
  assert.deepEqual(store.item.tree(epic.id).map((r) => r.id), [epic.id, story.id, task.id, sub.id]);
});

test("ids are opaque: kind comes from the row", (t) => {
  const store = makeStore(t);
  const epic = store.epic.create({ title: "E" });
  const story = store.story.create({ epicId: epic.id, title: "S" });
  const task = store.task.create({ storyId: story.id, title: "T" });
  for (const row of [epic, story, task]) assert.match(row.id, /^ITM-/);
  assert.equal(store.itemKindOf(epic.id), "epic");
  assert.equal(store.itemKindOf(story.id), "story");
  assert.equal(store.itemKindOf(task.id), "task");
  assert.equal(store.item.get(story.id).kind, "story");
});

test("claim/release/claim keeps every attempt and one live row", (t) => {
  const store = makeStore(t);
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  const task = store.task.create({ storyId: story.id, title: "T" });
  const first = store.task.claim({ id: task.id, agentId: "a", harness: "test", session: "s1" });
  assert.equal(first.status, "in_progress");
  assert.equal(store.attempt.list({ itemId: task.id, live: true }).length, 1);
  store.task.release(task.id);
  const second = store.task.claim({ id: task.id, agentId: "a", harness: "test", session: "s1" });
  assert.equal(second.status, "in_progress");
  const attempts = store.attempt.list({ itemId: task.id });
  assert.deepEqual(attempts.map((a) => [a.attempt_no, a.status]), [[2, "running"], [1, "released"]]);
  assert.equal(store.attempt.list({ itemId: task.id, live: true }).length, 1);
});

test("generated columns project the JSON and lease without a second write", (t) => {
  const store = makeStore(t);
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  const task = store.task.create({ storyId: story.id, title: "T" });
  store.task.claim({ id: task.id, agentId: "a", harness: "test", session: "s1", watchdogMs: 60_000 });
  store.task.update(task.id, { status: "done", result_summary: "shipped", actor: "a" });
  const [attempt] = store.attempt.list({ itemId: task.id });
  assert.equal(attempt.result_summary, "shipped");
  assert.ok(attempt.expires_at > attempt.claimed_at);
  const session = store.session.get(attempt.session_id);
  assert.equal(session.session_key, "test:a:s1");
});
