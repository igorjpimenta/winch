// store.race.test.js — the S0.3 acceptance criterion taken literally: N real
// OS processes racing one claim. In-process sequential calls prove the CAS
// predicate; only parallel processes with independent sqlite handles prove the
// transaction boundary under WAL contention.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createStore } from "../src/store.js";

const storeUrl = pathToFileURL(path.resolve(import.meta.dirname, "..", "src", "store.js")).href;
let dir;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

test("four processes race one claim: exactly one winner, exactly one claim event", async () => {
  dir = mkdtempSync(path.join(tmpdir(), "backlog-race-"));
  const dbPath = path.join(dir, "store.sqlite");
  const seed = createStore({ dbPath });
  const epic = seed.epic.create({ title: "E", status: "planned" });
  const story = seed.story.create({ epicId: epic.id, title: "S", status: "ready" });
  const task = seed.task.create({ storyId: story.id, title: "T", executionKind: "manual" });
  seed.close();

  const childScript = `
    import { createStore } from ${JSON.stringify(storeUrl)};
    const s = createStore({ dbPath: process.env.RACE_DB });
    const r = s.task.claim({ id: process.env.RACE_TASK, agentId: process.env.RACE_AGENT });
    process.stdout.write(JSON.stringify({ ok: !!r }));
    s.close();
  `;
  const claim = (agent) => new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", childScript],
      { env: { ...process.env, RACE_DB: dbPath, RACE_TASK: task.id, RACE_AGENT: agent } },
      (err, stdout) => {
        if (err) return resolve({ ok: false, err: String(err) });
        try { resolve(JSON.parse(stdout)); } catch { resolve({ ok: false, err: stdout }); }
      }
    );
  });

  const results = await Promise.all(["proc-a", "proc-b", "proc-c", "proc-d"].map(claim));
  const losers = results.filter((r) => !r.ok);
  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, `exactly one winner, got ${winners.length}: ${JSON.stringify(results)}`);
  assert.equal(losers.length, 3);

  const check = createStore({ dbPath });
  const claimEvents = check.db
    .prepare("SELECT * FROM events WHERE task_id=? AND note='claim'")
    .all(task.id);
  assert.equal(claimEvents.length, 1, "the claim event row is transactional — one per race");
  assert.equal(check.task.get(task.id).status, "in_progress");
  check.close();
});
