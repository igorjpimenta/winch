// shared.test.js — the helpers every handler depends on, tested directly:
// note clamping, the artifact collector, and the store-only handoff text.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../../../src/store.js";
import { clampNote, collectStoryArtifacts, renderReceiverPrompt } from "../../../src/tools/shared.js";

let dir, store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "winch-shared-"));
  store = createStore({ dbPath: path.join(dir, "store.sqlite") });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed() {
  const epic = store.epic.create({ title: "Epic", acceptance: "EP-AC", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "Story", acceptance: "STORY-AC", status: "ready" });
  const task = store.task.create({ storyId: story.id, title: "Task", status: "todo", executionKind: "manual" });
  return { epic, story, task };
}

test("clampNote keeps short notes and truncates long ones", () => {
  assert.equal(clampNote("short", 10), "short");
  const long = "x".repeat(30);
  const got = clampNote(long, 10);
  assert.equal(got.length, 11);
  assert.ok(got.endsWith("…"));
  assert.equal(clampNote(undefined), null);
  assert.equal(clampNote(42), null);
  assert.equal(clampNote("y".repeat(2500)).length, 2001);
});

test("collectStoryArtifacts reads artifact events and done summaries, deduped", () => {
  const { epic, story, task } = seed();
  store.db.prepare("INSERT INTO events(task_id,from_status,to_status,actor,note,at) VALUES(?,?,?,?,?,?)")
    .run(task.id, "todo", "todo", "atlas", "artifact: https://example.test/a", Date.now());
  store.task.update(task.id, { status: "done", result_summary: "done\n\nartifacts: https://example.test/b, https://example.test/a" });
  const artifacts = collectStoryArtifacts(store, story.id).sort();
  assert.deepEqual(artifacts, ["https://example.test/a", "https://example.test/b"]);
  assert.deepEqual(collectStoryArtifacts(store, "STORY-nope"), []);
  assert.ok(epic.id);
});

test("renderReceiverPrompt is a projection of the store and nothing else", () => {
  const { epic, story, task } = seed();
  const text = renderReceiverPrompt({ task, story, epic, artifacts: ["https://example.test/a"] });
  assert.match(text, /# Task: Task/);
  assert.match(text, /## Acceptance\nSTORY-AC/);
  assert.match(text, /- https:\/\/example\.test\/a/);
  assert.match(text, /## Parent\nEpic — Story/);
  const bare = renderReceiverPrompt({
    task: { ...task, description: null },
    story: { ...story, acceptance: null },
    epic,
    artifacts: [],
  });
  assert.match(bare, /\(none recorded\)/);
  assert.match(bare, /\(none yet\)/);
  assert.ok(!bare.includes("## Context"));
  // Extra keys on the input cannot leak into the prompt.
  const noisy = renderReceiverPrompt({ task: { ...task, secret: "leak" }, story, epic, artifacts: [] });
  assert.ok(!noisy.includes("leak"));
});
