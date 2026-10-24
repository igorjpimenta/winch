// cli.test.js — construction rejects identity flags that belong to per-call meta.
// The --config surface: every command that builds a store takes --config
// JSON|PATH and passes loadConfig(values) to openStore, so an unknown knob
// refuses (bad <key>) at construction and an absent flag is byte-identical
// to the old behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";

const root = path.join(import.meta.dirname, "..");
const bin = path.join(root, "bin", "winch.js");

const GOOD_CONFIG = '{"leaseSeconds":300}';
const BAD_CONFIG = '{"nope":1}';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "winch-cli-"));
  return { dir, dbPath: path.join(dir, "store.sqlite") };
}

function run(args, { dbPath, cwd } = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    cwd: cwd ?? root,
    env: { ...process.env, WINCH_DB: dbPath ?? path.join(os.tmpdir(), "winch-cli-none.sqlite") },
  });
}

test("winch mcp rejects --agent/--session with a per-call identity error", () => {
  const r = spawnSync(
    process.execPath,
    [path.join(root, "bin/winch.js"), "mcp", "--harness", "test", "--agent", "a"],
    { encoding: "utf8" }
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /per-call identity, not construction flags/);
  assert.doesNotMatch(r.stderr, /ERR_PARSE_ARGS_UNKNOWN_OPTION/);
});

// ── refuse: unknown knob fails at construction, naming the key ──────────────

const REFUSE_CASES = [
  ["resume", ["resume", "TASK-none", "--config", BAD_CONFIG]],
  ["next", ["next", "--config", BAD_CONFIG]],
  ["release-epic", ["release-epic", "--epic", "EPIC-none", "--config", BAD_CONFIG]],
  ["merge-detect", ["merge-detect", "--config", BAD_CONFIG]],
];

for (const [cmd, args] of REFUSE_CASES) {
  test(`${cmd} refuses --config with an unknown knob (exit != 0, stderr names it)`, () => {
    const { dbPath, dir } = tempDb();
    const r = run(args, { dbPath, cwd: dir });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /bad/);
    assert.match(r.stderr, /nope/);
  });
}

// ── accept: inline JSON form ────────────────────────────────────────────────

test("next accepts --config JSON form", () => {
  const { dbPath, dir } = tempDb();
  const r = run(["next", "--config", GOOD_CONFIG], { dbPath, cwd: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^\[\]/);
});

test("resume accepts --config JSON form", () => {
  const { dbPath, dir } = tempDb();
  const store = createStore({ dbPath });
  const epic = store.epic.create({ title: "epic" });
  const story = store.story.create({ epicId: epic.id, title: "story", status: "ready" });
  const task = store.task.create({ storyId: story.id, title: "gated" });
  store.task.openGate({ id: task.id, gateType: "architecture", reason: "test" });
  store.close();
  const r = run(["resume", task.id, "--config", GOOD_CONFIG], { dbPath, cwd: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, new RegExp(task.id));
});

test("release-epic accepts --config JSON form", () => {
  const { dbPath, dir } = tempDb();
  const r = run(["release-epic", "--epic", "EPIC-none", "--config", GOOD_CONFIG], { dbPath, cwd: dir });
  // Past construction and flag parsing: the command fails on its own domain.
  assert.equal(r.status, 1);
  assert.match(r.stderr, /release-epic failed: epic not found/);
  assert.doesNotMatch(r.stderr, /\(bad |neither JSON/);
});

test("merge-detect accepts --config JSON form", () => {
  const { dbPath, dir } = tempDb();
  // cwd is a non-repo temp dir: collectPRs' gh call runs in its own domain.
  const r = run(["merge-detect", "--config", GOOD_CONFIG], { dbPath, cwd: dir });
  assert.doesNotMatch(r.stderr, /\(bad |neither JSON/);
  if (r.status === 0) {
    const summary = JSON.parse(r.stdout);
    for (const key of ["doneTasks", "reopenedTasks", "closedEpics", "tagged", "skipped"]) {
      assert.ok(Array.isArray(summary[key]), `summary.${key}`);
    }
  } else {
    // gh hard-fails outside a repo on some setups — still past construction.
    assert.match(r.stderr, /merge-detect failed/);
  }
});

// ── accept: file path form ──────────────────────────────────────────────────

test("next accepts --config PATH form (JSON file)", () => {
  const { dbPath, dir } = tempDb();
  const cfgPath = path.join(dir, "winch.json");
  fs.writeFileSync(cfgPath, GOOD_CONFIG);
  const r = run(["next", "--config", cfgPath], { dbPath, cwd: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^\[\]/);
});

// ── help documents the flag on all four ─────────────────────────────────────

test("help lists --config on resume, next, release-epic, merge-detect", () => {
  const r = run(["--help"], {});
  assert.equal(r.status, 0);
  for (const cmd of ["resume", "next", "release-epic", "merge-detect"]) {
    const line = r.stdout.split("\n").find((l) => l.trimStart().startsWith(cmd));
    assert.ok(line, `help line for ${cmd}`);
    assert.ok(line.includes("--config"), `help line for ${cmd} names --config: ${line}`);
  }
});
