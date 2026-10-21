// merges.test.js — S2.6: marker parsing, merge/close outcomes, idempotence,
// tag command contract.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";
import { parseMarkers, applyMergeOutcomes, collectPRs } from "../src/merges.js";

let dir, store, epic, story, task;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "backlog-merges-"));
  store = createStore({ dbPath: path.join(dir, "store.sqlite") });
  epic = store.epic.create({ title: "Ship v1", status: "in_progress" });
  story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  task = store.task.create({ storyId: story.id, title: "T", executionKind: "manual" });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const pr = (n, state, body, title = "whatever") => ({ number: n, state, body, title });

test("parseMarkers: all three markers, partials, absent", () => {
  const full = parseMarkers("notes\nBacklog: EPIC-1\nBacklog-Task: TASK-2\nRelease: v9.9.9\n");
  assert.deepEqual(full, { epicId: "EPIC-1", taskId: "TASK-2", version: "v9.9.9" });
  assert.deepEqual(parseMarkers("Backlog: EPIC-1\n"), { epicId: "EPIC-1", taskId: null, version: null });
  assert.deepEqual(parseMarkers("no markers"), { epicId: null, taskId: null, version: null });
});

test("merged PR with task marker: task done with merge event; rerun idempotent", () => {
  const body = `Backlog: ${epic.id}\nBacklog-Task: ${task.id}`;
  const prs = [pr(7, "MERGED", body, "feat: the thing")];
  const first = applyMergeOutcomes(store, prs);
  assert.deepEqual(first.doneTasks, [task.id]);
  assert.equal(store.task.get(task.id).status, "done");
  assert.match(store.task.get(task.id).result_summary, /PR #7: feat: the thing/);
  const second = applyMergeOutcomes(store, prs);
  assert.deepEqual(second.doneTasks, [], "second run is a no-op");
});

test("merged PR with version: epic closes, tag converges across runs", () => {
  // Model real git: tagging an existing tag fails — the detector must land
  // that failure in skipped instead of crashing, and a re-run stays safe.
  const calls = [];
  const tags = new Set();
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args.includes("tag")) {
      const v = args[args.indexOf("tag") + 1];
      if (tags.has(v)) throw new Error("fatal: tag 'v2.0.0' already exists");
      tags.add(v);
    }
    return "";
  };
  const body = `Backlog: ${epic.id}\nRelease: v2.0.0`;
  const first = applyMergeOutcomes(store, [pr(8, "MERGED", body)], { exec });
  assert.deepEqual(first.closedEpics, [epic.id]);
  assert.equal(store.epic.get(epic.id).status, "done");
  assert.deepEqual(first.tagged, ["v2.0.0"]);
  assert.deepEqual(calls, [["git", "tag", "v2.0.0"]]);

  const second = applyMergeOutcomes(store, [pr(8, "MERGED", body)], { exec });
  assert.deepEqual(second.closedEpics, [], "epic idempotent");
  assert.deepEqual(second.tagged, [], "no re-tag");
  assert.deepEqual(second.skipped, ["release:v2.0.0 (no release task)", "tag:v2.0.0"], "git's 'already exists' lands in skipped, alongside the unanchored release");
  assert.equal(calls.length, 2, "second attempt occurred and was absorbed");
});

test("closed-unmerged PR reclaims an in-flight task; done is never rewritten", () => {
  const body = `Backlog: ${epic.id}\nBacklog-Task: ${task.id}`;
  store.task.update(task.id, { status: "in_progress", assigned: "builder" });
  const s1 = applyMergeOutcomes(store, [pr(9, "CLOSED", body)]);
  assert.deepEqual(s1.reopenedTasks, [task.id]);
  const reopened = store.task.get(task.id);
  assert.equal(reopened.status, "todo");
  assert.equal(reopened.assigned, null);

  store.task.update(task.id, { status: "done", result_summary: "done" });
  const s2 = applyMergeOutcomes(store, [pr(9, "CLOSED", body)]);
  assert.deepEqual(s2.reopenedTasks, [], "history stays");
});

test("PRs without markers and open PRs are untouched", () => {
  const s = applyMergeOutcomes(store, [pr(1, "MERGED", "unrelated"), pr(2, "OPEN", `Backlog: ${epic.id}`)]);
  assert.deepEqual(s.doneTasks, []);
  assert.equal(store.task.get(task.id).status, "todo");
  assert.equal(store.epic.get(epic.id).status, "in_progress");
  assert.deepEqual(s.skipped, ["pr#2:OPEN"]);
});

test("collectPRs builds the gh query", () => {
  const calls = [];
  const exec = (cmd, args) => { calls.push([cmd, ...args]); return "[]"; };
  const rows = collectPRs({ exec });
  assert.deepEqual(rows, []);
  const [cmd, ...args] = calls[0];
  assert.equal(cmd, "gh");
  assert.deepEqual(args.slice(0, 4), ["pr", "list", "--state", "merged"]);
  assert.ok(args.includes("--json") && args.join(" ").includes("body,state"));
});

test("epic close with version writes one release event on the release task", () => {
  const epic = store.epic.create({ title: "E", status: "in_progress" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  const task = store.task.create({ storyId: story.id, title: "R", executionKind: "manual" });
  store.task.update(task.id, { status: "done", actor: "herald", note: "done" });
  const body = `Backlog: ${epic.id}\nBacklog-Task: ${task.id}\nRelease: v2.0.0`;
  const first = applyMergeOutcomes(store, [{ number: 11, state: "MERGED", title: "ship", body }]);
  assert.deepEqual(first.closedEpics, [epic.id]);
  const rows = store.db.prepare("SELECT * FROM events WHERE task_id=? AND note LIKE 'release shipped:%'").all(task.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, "release shipped: v2.0.0");
  assert.equal(rows[0].from_status, "done");
  assert.equal(rows[0].to_status, "done");

  const second = applyMergeOutcomes(store, [{ number: 11, state: "MERGED", title: "ship", body }]);
  assert.deepEqual(second.closedEpics, [], "epic idempotent");
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE note LIKE 'release shipped:%'").get().n,
    1, "no duplicate release event on re-run"
  );
});

test("epic close with version but no release task records a skip, writes nothing", () => {
  const epic = store.epic.create({ title: "E2", status: "in_progress" });
  const body = `Backlog: ${epic.id}\nRelease: v3.0.0`;
  const out = applyMergeOutcomes(store, [{ number: 12, state: "MERGED", title: "ship", body }]);
  assert.deepEqual(out.closedEpics, [epic.id]);
  assert.deepEqual(out.skipped, ["release:v3.0.0 (no release task)"]);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE note LIKE 'release shipped:%'").get().n,
    0
  );
});

test("failed tag writes no release event — the wire never claims an untagged ship", () => {
  const body = `Backlog: ${epic.id}\nBacklog-Task: ${task.id}\nRelease: v9.9.9`;
  store.task.update(task.id, { status: "done", actor: "herald", note: "done" });
  const exec = () => { throw new Error("fatal: cannot lock ref 'refs/tags/v9.9.9'"); };
  const out = applyMergeOutcomes(store, [{ number: 21, state: "MERGED", title: "ship", body }], { exec });
  assert.deepEqual(out.tagged, [], "nothing tagged");
  assert.deepEqual(out.skipped, ["tag:v9.9.9"], "failure recorded, no event alongside");
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE note LIKE 'release shipped:%'").get().n,
    0, "no shipped row without a tag"
  );
  assert.deepEqual(out.closedEpics, [epic.id], "epic close reflects the merged PR, not the tag");
});

test("merge completing a held task names the displaced holder in the note", () => {
  store.task.claim({ id: task.id, agentId: "builder" });
  const body = `Backlog: ${epic.id}\nBacklog-Task: ${task.id}`;
  const out = applyMergeOutcomes(store, [pr(22, "MERGED", body, "feat: landed")]);
  assert.deepEqual(out.doneTasks, [task.id]);
  const ev = store.db.prepare("SELECT note FROM events WHERE task_id=? AND note LIKE 'merged: PR%'").all(task.id);
  assert.equal(ev.length, 1);
  assert.match(ev[0].note, /merged: PR #22 \(displaced builder\)/);
});
