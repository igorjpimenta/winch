// store.test.js — schema creation, CAS claim, sweeper, heartbeat.
// node:test + node:assert, zero deps. Each test gets a throwaway DB in
// os.tmpdir(); the live ~/.winch/store.sqlite is never touched.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore, MAX_ATTEMPTS } from "../../src/store.js";
import { kindForEvent } from "../../src/events-ws.js";
import Database from "better-sqlite3";

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "backlog-store-"));
  return { dir, dbPath: path.join(dir, "store.sqlite") };
}

function makeStore(t) {
  const { dir, dbPath } = tempDb();
  const store = createStore({ dbPath });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

function seedHierarchy(store) {
  const epic  = store.epic.create({ title: "epic" });
  const story = store.story.create({ epicId: epic.id, title: "story", status: "ready" });
  const task  = store.task.create({ storyId: story.id, title: "task" });
  return { epic, story, task };
}

function eventsFor(store, taskId) {
  return store.db.prepare("SELECT * FROM item_events WHERE item_id=? ORDER BY id").all(taskId);
}

// ───────────────────────────────────────────────────────────── S0.3 CAS

test("S0.3: claim is CAS — first wins, loser gets null, re-claim after release wins", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);

  const claimed = store.task.claim({ id: task.id, agentId: "agent-a" });
  assert.ok(claimed);
  assert.equal(claimed.status, "in_progress");
  assert.equal(claimed.assigned, "agent-a");
  assert.equal(claimed.lease_seconds, 1800);

  const evs = eventsFor(store, task.id);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].from_status, null);
  assert.equal(evs[0].to_status, "todo");
  assert.equal(evs[0].note, "task created");
  assert.equal(evs[1].from_status, "todo");
  assert.equal(evs[1].to_status, "in_progress");
  assert.equal(evs[1].actor, "agent-a");
  assert.equal(evs[1].note, "claim");

  assert.equal(store.task.claim({ id: task.id, agentId: "agent-b" }), null);
  assert.equal(store.task.claim({ id: task.id, agentId: "agent-a" }), null);

  assert.ok(store.task.release(task.id));
  const again = store.task.claim({ id: task.id, agentId: "agent-a" });
  assert.ok(again, "assigned agent re-claims after release");
  assert.equal(again.status, "in_progress");
});

test("S0.3 atomicity: claim event `at` equals the claim's `claimed_at`", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);
  const claimed = store.task.claim({ id: task.id, agentId: "agent-a" });
  assert.equal(claimed.lastEvent.created_at, claimed.claimed_at);
  assert.equal(claimed.lastEvent.note, "claim");
});

// ───────────────────────────────────────────────────────── S0.4 SWEEPER

test("S0.4: sweeper re-releases expired claims, escalates at MAX_ATTEMPTS", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);

  let sweepAt = Date.now() + 10;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const claimed = store.task.claim({ id: task.id, agentId: "agent-a", watchdogMs: 1 });
    assert.ok(claimed, `claim ${attempt} succeeds`);
    const swept = store.task.sweepExpired({ now: sweepAt += 1000 });
    assert.equal(swept.length, 1);
    const after = store.task.get(task.id);
    if (attempt < MAX_ATTEMPTS) {
      assert.equal(after.status, "todo");
      assert.equal(after.attempt_count, attempt);
    } else {
      assert.equal(after.status, "blocked");
      assert.equal(after.attempt_count, MAX_ATTEMPTS);
    }
  }

  const evs = eventsFor(store, task.id);
  // birth + 3 claims + 3 sweep-releases + 1 escalation
  assert.equal(evs.length, 2 + 2 * MAX_ATTEMPTS);
  const sweeps = evs.filter((e) => e.note === "sweeper");
  assert.equal(sweeps.length, MAX_ATTEMPTS);
  for (const e of sweeps) {
    assert.equal(e.from_status, "in_progress");
    assert.equal(e.to_status, "todo");
  }
  const last = evs[evs.length - 1];
  assert.equal(last.note, "blocked: max attempts");
  assert.equal(last.from_status, "todo");
  assert.equal(last.to_status, "blocked");
});

test("S0.4: sweeper ignores unexpired and non-in_progress tasks", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);
  store.task.claim({ id: task.id, agentId: "agent-a", watchdogMs: 60_000 });
  assert.deepEqual(store.task.sweepExpired({ now: Date.now() }), []);
  assert.equal(store.task.get(task.id).status, "in_progress");
});

// ─────────────────────────────────────────────────────────── HEARTBEAT

test("heartbeat: advances last_heartbeat only for the assigned in_progress agent", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);

  assert.equal(store.task.heartbeat(task.id, "agent-a"), null, "todo task cannot heartbeat");

  const claimed = store.task.claim({ id: task.id, agentId: "agent-a" });
  const beat = store.task.heartbeat(task.id, "agent-a");
  assert.ok(beat);
  assert.ok(beat.last_heartbeat >= claimed.last_heartbeat);
  assert.equal(store.task.heartbeat(task.id, "agent-b"), null, "wrong agent rejected");

  const evCount = eventsFor(store, task.id).length;
  assert.equal(evCount, 2, "heartbeats write no event rows (birth + claim only)");
});

// ────────────────────────────────────────────────────── UPDATE EVENTS

test("task.update: status change writes an event; other patches do not", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);

  store.task.update(task.id, { description: "clarified" });
  assert.equal(eventsFor(store, task.id).length, 1, "birth row only");

  const done = store.task.update(task.id, { status: "done", actor: "agent-a", note: "finished" });
  assert.equal(done.status, "done");
  const evs = eventsFor(store, task.id);
  assert.equal(evs.length, 2);
  assert.equal(evs[1].from_status, "todo");
  assert.equal(evs[1].to_status, "done");
  assert.equal(evs[1].actor, "agent-a");
  assert.equal(evs[1].note, "finished");
});

test("task.update: actor/note optional — defaults to system", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);
  store.task.update(task.id, { status: "blocked" });
  const ev = eventsFor(store, task.id)[1];
  assert.equal(ev.actor, "system");
  assert.equal(ev.note, null);
});

test("an expired lease requeues the task to its own worker", (t) => {
  const store = makeStore(t);
  const epic = store.epic.create({ title: "E-sweep", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S-sweep", status: "ready" });
  const task = store.task.create({ storyId: story.id, title: "t", status: "todo", executionKind: "manual", assigned: "worker" });
  store.task.claim({ id: task.id, agentId: "worker", sessionKey: "s", watchdogMs: 1000 });
  store.task.sweepExpired({ now: Date.now() + 5000 });
  const after = store.task.get(task.id);
  assert.equal(after.status, "todo");
  assert.equal(after.assigned, "worker", "the owner is kept so a dispatcher can re-wake it");
  assert.equal(after.attempt_count, 1);
});

test("v6 data is copied into the v8 tree without losing ids or event order", (t) => {
  const { dir, dbPath } = tempDb();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  {
    const db = new Database(dbPath);
    // Build a complete v6 store by replaying the pre-v8 migrations, then
    // write one row at each level. This is the shape a live install has on
    // the day 0006 runs.
    for (const name of ["0000_next_katie_power", "0001_add-events-kind", "0003_pink_siren", "0004_salty_trauma", "0005_classy_havok"]) {
      const sql = readFileSync(new URL(`../../.migrations/${name}.sql`, import.meta.url), "utf8");
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

test("heartbeat renews the claim lease — a live agent is never swept", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);
  store.task.claim({ id: task.id, agentId: "agent-a", watchdogMs: 60 * 1000 });
  // Expire the lease out from under a live agent, then heartbeat.
  store.db.prepare("UPDATE attempts SET claimed_at=1, heartbeat_at=1 WHERE item_id=? AND ended_at IS NULL").run(task.id);
  const beat = store.task.heartbeat(task.id, "agent-a");
  assert.ok(beat, "heartbeat accepted");
  assert.ok(beat.claim_expires_at > Date.now(), "lease renewed into the future");
  assert.deepEqual(store.task.sweepExpired({}), [], "nothing swept");
  assert.equal(store.task.get(task.id).status, "in_progress");
});
