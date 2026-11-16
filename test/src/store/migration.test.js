// The in-place migration: legacy data lands in the recursive tree without
// losing ids, event order, assignments, or webhook targets.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { createStore } from "../../../src/store/index.js";
import { kindForEvent } from "../../../src/events-ws.js";
import Database from "better-sqlite3";
import { tempDb } from "./_helpers.js";

test("legacy data is copied into the recursive tree without losing ids or event order", (t) => {
  const { dir, dbPath } = tempDb("winch-migration-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  {
    const db = new Database(dbPath);
    // Replay the migrations before 0006, then seed one row at each level:
    // the shape 0006 must accept.
    for (const name of ["0000_next_katie_power", "0001_add-events-kind", "0003_pink_siren", "0004_salty_trauma", "0005_classy_havok"]) {
      const sql = readFileSync(new URL(`../../../.migrations/${name}.sql`, import.meta.url), "utf8");
      for (const stmt of sql.split("--> statement-breakpoint")) if (stmt.trim()) db.exec(stmt);
    }
    db.exec(`
      INSERT INTO epics(id,title,description,acceptance,status,owner_team,priority,created_by,created_at,updated_at)
        VALUES('EPIC-1','Ship','D','A','planned','core',70,'atlas',1000,1000);
      INSERT INTO stories(id,epic_id,title,description,acceptance,status,size,priority,assigned,capabilities,created_at,updated_at)
        VALUES('STORY-1','EPIC-1','Flow',NULL,'works','ready','m',60,'tester','["verify"]',2000,2000);
      INSERT INTO tasks(id,story_id,title,description,status,execution_kind,execution_args,assigned,capabilities,attempt_count,created_at,updated_at,claimed_at)
        VALUES('TASK-1','STORY-1','Build',NULL,'done','manual','{}','builder','["build"]',1,3000,4000,3500);
      INSERT INTO deps(from_id,from_kind,to_id,to_kind,created_at) VALUES('TASK-1','task','EPIC-1','epic',5000);
      INSERT INTO events(task_id,item_kind,from_status,to_status,kind,actor,note,session_ref,at)
        VALUES('TASK-1','task',NULL,'todo','task.created',NULL,'task created','harness:builder:s1',3000),
              ('TASK-1','task','in_progress','done','task.completed','builder','done','harness:builder:s1',4000);
      INSERT INTO webhook_targets(harness,url,bearer,timeout_ms,created_at,updated_at)
        VALUES('openclaw','http://127.0.0.1:9/hook','tok',1500,6000,6000);
    `);
    db.exec(`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC NOT NULL);
      INSERT INTO __drizzle_migrations(hash, created_at) VALUES ('0005-ledger', 1793063101061);`);
    db.close();
  }
  const store = createStore({ dbPath });
  t.after(() => store.close());

  const epic = store.item.get("EPIC-1", { includeDeleted: true });
  const story = store.item.get("STORY-1", { includeDeleted: true });
  const task = store.item.get("TASK-1", { includeDeleted: true });
  assert.equal(epic.kind, "epic");
  assert.equal(epic.status, "ready", "legacy planned maps to ready");
  assert.equal(story.kind, "story");
  assert.equal(story.epic_id, "EPIC-1");
  assert.equal(task.kind, "task");
  assert.equal(task.story_id, "STORY-1");
  assert.equal(task.status, "done");
  assert.equal(task.attempt_count, 1);
  assert.deepEqual(story.capabilities, ["verify"]);
  assert.deepEqual(task.capabilities, ["build"]);
  assert.equal(store.dep.listOutgoing("TASK-1")[0].to_id, "EPIC-1");

  const attempts = store.attempt.list({ itemId: "TASK-1" });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "done");
  assert.equal(attempts[0].session_id, store.session.get(attempts[0].session_id).id);

  const events = store.event.listFor("TASK-1");
  assert.deepEqual(events.map((e) => e.id), [1, 2]);
  assert.equal(events[1].kind, "task.completed");
  assert.equal(events[1].actor, "builder");

  assert.equal(store.webhook.get("openclaw").url, "http://127.0.0.1:9/hook");
  assert.ok(!store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='epics'").get());
  assert.equal(kindForEvent({ from_status: "in_progress", to_status: "blocked", kind: null, note: "blocked: need signoff" }), "task.blocked");
});
