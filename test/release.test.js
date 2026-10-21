// release.test.js — S2.5: notes rendering from the store + the git/gh
// command contract (via injected exec; real gh is the post-merge smoke).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";
import { renderReleaseNotes, shipRelease } from "../src/release.js";

let dir, store, epic, story, task;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "backlog-release-"));
  store = await createStore({ dbPath: path.join(dir, "store.sqlite") });
  epic = store.epic.create({ title: "Ship v1", status: "in_progress", priority: 90, acceptance: "All gates passed" });
  story = store.story.create({ epicId: epic.id, title: "Core flow", status: "review", acceptance: "Works end-to-end" });
  task = store.task.create({ storyId: story.id, title: "Build it", executionKind: "manual" });
  store.task.update(task.id, { status: "done", result_summary: "done\nartifacts: pr:42", actor: "builder", note: "done" });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("renderReleaseNotes projects the epic: statuses, acceptance, results, audit", () => {
  const md = renderReleaseNotes(store, epic.id);
  assert.match(md, /# Release notes — Ship v1/);
  assert.match(md, /All gates passed/);
  assert.match(md, /\[review\] STORY-.* Core flow — Works end-to-end/);
  assert.match(md, /\[x\] TASK-.* Build it — done/);
  assert.match(md, /## Audit/);
  assert.match(md, /\d+ recorded events/);
});

test("renderReleaseNotes surfaces open gates", () => {
  const t2 = store.task.create({ storyId: story.id, title: "Approve", executionKind: "manual" });
  store.task.openGate({ id: t2.id, gateType: "release", actor: "herald" });
  const md = renderReleaseNotes(store, epic.id);
  assert.match(md, /## Open gates/);
  assert.match(md, /release: TASK-.* Approve/);
});

test("shipRelease: Angular commit, backlog markers in PR body, branch per epic", () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "gh") return "https://github.example/pull/99\n";
    return "";
  };
  const r = shipRelease(store, { epicId: epic.id, taskId: task.id, version: "v1.2.0", base: "main", exec });
  assert.equal(r.branch, `release/${epic.id.toLowerCase()}`);
  assert.equal(r.prUrl, "https://github.example/pull/99");
  const commit = calls.find(([c, ...a]) => c === "git" && a[0] === "commit");
  assert.match(commit.join(" "), /docs\(release\): Ship v1/);
  const prCreate = calls.find(([c]) => c === "gh");
  const bodyIdx = prCreate.indexOf("--body") + 1;
  const body = prCreate[bodyIdx];
  assert.match(body, new RegExp(`Backlog: ${epic.id}`));
  assert.match(body, new RegExp(`Backlog-Task: ${task.id}`));
  assert.match(body, /Release: v1\.2\.0/);
  assert.match(body, /Release notes — Ship v1/);
});

test("shipRelease without taskId/version omits those markers", () => {
  const calls = [];
  const exec = (cmd, args) => { calls.push([cmd, ...args]); return cmd === "gh" ? "url\n" : ""; };
  shipRelease(store, { epicId: epic.id, exec });
  const prCreate = calls.find(([c]) => c === "gh");
  const body = prCreate[prCreate.indexOf("--body") + 1];
  assert.match(body, new RegExp(`Backlog: ${epic.id}`));
  assert.ok(!body.includes("Backlog-Task:"));
  assert.ok(!body.includes("Release:"));
});
