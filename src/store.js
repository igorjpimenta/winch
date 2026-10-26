// store.js — backlog data layer over better-sqlite3 + Drizzle.
//
// Schema lives in src/schema.js; drizzle-kit generates the SQL in .migrations/
// and db.js applies it on open. The query bodies use the same better-sqlite3
// connection; JSON columns hold capabilities + execution_args opaquely.
//
// Concurrency: WAL mode enabled. CLI and gateway processes can read/write the
// same DB concurrently; sqlite serializes the writes.

import { newEpicId, newStoryId, newTaskId, classifyId } from "./ids.js";
import { resolveConfig } from "./config.js";
import { resolveDbPath } from "./paths.js";
import { openDatabase } from "./db.js";
import {
  EPIC_STATUSES,
  STORY_STATUSES,
  TASK_STATUSES,
  EXECUTION_KINDS,
  ITEM_KINDS,
} from "./schema.js";

// Tasks that exhaust this many sweeper re-releases escalate to 'blocked';
// claim/release and sweepExpired both read it.
export const MAX_ATTEMPTS = 3;

export { EPIC_STATUSES, STORY_STATUSES, TASK_STATUSES, EXECUTION_KINDS, ITEM_KINDS };

const STORY_TERMINAL = new Set(["done", "cancelled"]);
const TASK_TERMINAL  = new Set(["done", "cancelled"]);
const EPIC_TERMINAL  = new Set(["done", "cancelled"]);


function now() { return Date.now(); }
function jsonOut(v) { return v == null ? null : JSON.stringify(v); }
function jsonIn(v)  { if (v == null) return null; try { return JSON.parse(v); } catch { return null; } }

function rowEpic(r) {
  if (!r) return null;
  return { ...r };
}
function rowStory(r) {
  if (!r) return null;
  return { ...r, capabilities: jsonIn(r.capabilities) };
}
function rowTask(r) {
  if (!r) return null;
  return { ...r, capabilities: jsonIn(r.capabilities), execution_args: jsonIn(r.execution_args) ?? {} };
}

export function createStore({ dbPath, logger, config: explicitConfig } = {}) {
  const finalPath = dbPath || resolveDbPath();
  const { sqlite: db, orm } = openDatabase({ dbPath: finalPath, logger });
  // Tuning config resolves once, here: explicit object > WINCH_* env >
  // code defaults. Every consumer below reads this closure, so one resolved
  // object governs lease, sweep, waits and caps for the store's lifetime.
  const cfg = resolveConfig({ explicit: explicitConfig ?? {} });

  // ────────────────────────────────────────────────────────────── EPICS
  const epicApi = {
    create({ title, description, acceptance, status, ownerTeam, priority, id }) {
      const epicId = id || newEpicId();
      const t = now();
      const s = status || "idea";
      if (!EPIC_STATUSES.includes(s)) throw new Error(`invalid epic status: ${s}`);
      db.prepare(`
        INSERT INTO epics(id, title, description, acceptance, status, owner_team, priority, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(epicId, title, description ?? null, acceptance ?? null, s, ownerTeam ?? null, priority ?? 50, t, t);
      return epicApi.get(epicId);
    },
    get(id) {
      return rowEpic(db.prepare("SELECT * FROM epics WHERE id=?").get(id));
    },
    list({ status } = {}) {
      const sql = status
        ? "SELECT * FROM epics WHERE status=? ORDER BY priority DESC, created_at ASC"
        : "SELECT * FROM epics ORDER BY priority DESC, created_at ASC";
      return db.prepare(sql).all(...(status ? [status] : [])).map(rowEpic);
    },
    update(id, patch) {
      const existing = epicApi.get(id);
      if (!existing) throw new Error(`epic not found: ${id}`);
      if (patch.status && !EPIC_STATUSES.includes(patch.status)) throw new Error(`invalid epic status: ${patch.status}`);
      const merged = { ...existing, ...patch, updated_at: now() };
      if (patch.status && EPIC_TERMINAL.has(patch.status) && !existing.closed_at) merged.closed_at = merged.updated_at;
      db.prepare(`
        UPDATE epics SET title=?, description=?, acceptance=?, status=?, owner_team=?, priority=?, updated_at=?, closed_at=?
        WHERE id=?
      `).run(merged.title, merged.description, merged.acceptance, merged.status, merged.owner_team, merged.priority, merged.updated_at, merged.closed_at, id);
      return epicApi.get(id);
    },
    delete(id) {
      const r = db.prepare("DELETE FROM epics WHERE id=?").run(id);
      return r.changes > 0;
    },
  };

  // ────────────────────────────────────────────────────────────── STORIES
  const storyApi = {
    create({ epicId, title, description, acceptance, status, size, priority, assigned, capabilities, id }) {
      if (!epicApi.get(epicId)) throw new Error(`epic not found: ${epicId}`);
      const storyId = id || newStoryId();
      const t = now();
      const s = status || "backlog";
      if (!STORY_STATUSES.includes(s)) throw new Error(`invalid story status: ${s}`);
      db.prepare(`
        INSERT INTO stories(id, epic_id, title, description, acceptance, status, size, priority, assigned, capabilities, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(storyId, epicId, title, description ?? null, acceptance ?? null, s, size ?? null, priority ?? 50, assigned ?? null, jsonOut(capabilities), t, t);
      return storyApi.get(storyId);
    },
    get(id) {
      return rowStory(db.prepare("SELECT * FROM stories WHERE id=?").get(id));
    },
    list({ epicId, status, assigned } = {}) {
      const where = [];
      const args = [];
      if (epicId)   { where.push("epic_id=?"); args.push(epicId); }
      if (status)   { where.push("status=?");  args.push(status); }
      if (assigned) { where.push("assigned=?"); args.push(assigned); }
      const sql = `SELECT * FROM stories${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY priority DESC, created_at ASC`;
      return db.prepare(sql).all(...args).map(rowStory);
    },
    update(id, patch) {
      const existing = storyApi.get(id);
      if (!existing) throw new Error(`story not found: ${id}`);
      if (patch.status && !STORY_STATUSES.includes(patch.status)) throw new Error(`invalid story status: ${patch.status}`);
      const merged = {
        ...existing,
        ...patch,
        capabilities: patch.capabilities !== undefined ? patch.capabilities : existing.capabilities,
        updated_at: now(),
      };
      if (patch.status && STORY_TERMINAL.has(patch.status) && !existing.closed_at) merged.closed_at = merged.updated_at;
      db.prepare(`
        UPDATE stories SET title=?, description=?, acceptance=?, status=?, size=?, priority=?, assigned=?, capabilities=?, updated_at=?, closed_at=?
        WHERE id=?
      `).run(merged.title, merged.description, merged.acceptance, merged.status, merged.size, merged.priority, merged.assigned, jsonOut(merged.capabilities), merged.updated_at, merged.closed_at, id);
      return storyApi.get(id);
    },
    delete(id) {
      const r = db.prepare("DELETE FROM stories WHERE id=?").run(id);
      return r.changes > 0;
    },
  };

  // ────────────────────────────────────────────────────────────── TASKS
  // Every status-changing caller writes its event row inside the same
  // transaction as the UPDATE — a status change committed without its event
  // desyncs the audit trail the sweeper and operators read.
  function insertEvent({ taskId, fromStatus, toStatus, kind = null, actor, note, at, sessionRef }) {
    const r = db.prepare(`
      INSERT INTO events(task_id, from_status, to_status, kind, actor, note, session_ref, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, fromStatus ?? null, toStatus, kind, actor ?? null, note ?? null, sessionRef ?? null, at);
    return Number(r.lastInsertRowid);
  }

  function rowEvent(r) { return r ? { ...r } : null; }

  // Kind declared at write time from the transition plus gate context —
  // the single table every update() event goes through, so producers never
  // reimplement it and readers never infer it. Reads state, never note text:
  // notes are free text and can change, but whether the row held a gate is
  // a fact — a gated exit outside the approval path dissolves, always.
  // Approval itself flows exclusively through resumeGate's explicit stamp;
  // no vocabulary is consulted here, so no rewording can reclassify a row.
  function kindForUpdate(existing, merged) {
    if (merged.status === "blocked" && existing.status !== "blocked") {
      return merged.gate_type ? "gate.opened" : "task.blocked";
    }
    if (existing.status === "blocked" && merged.status === "todo") {
      return existing.gate_type ? "gate.dissolved" : "task.released";
    }
    if (merged.status === "done") return "task.completed";
    if (merged.status === "cancelled") return "task.cancelled";
    if (existing.status === "todo" && merged.status === "in_progress") return "task.claimed";
    if (merged.status === "todo") return "task.released";
    return "task.updated";
  }

  const taskApi = {
    create({ storyId, title, description, status, executionKind, executionArgs, capabilities, assigned, id }) {
      if (!storyApi.get(storyId)) throw new Error(`story not found: ${storyId}`);
      const taskId = id || newTaskId();
      const t = now();
      const s = status || "todo";
      const ek = executionKind || "manual";
      if (!TASK_STATUSES.includes(s))     throw new Error(`invalid task status: ${s}`);
      if (!EXECUTION_KINDS.includes(ek))  throw new Error(`invalid execution_kind: ${ek}`);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`
          INSERT INTO tasks(id, story_id, title, description, status, execution_kind, execution_args, capabilities, assigned, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(taskId, storyId, title, description ?? null, s, ek, JSON.stringify(executionArgs ?? {}), jsonOut(capabilities), assigned ?? null, t, t);
        insertEvent({ taskId, fromStatus: null, toStatus: s, kind: "task.created", actor: null, note: "task created", at: t });
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return taskApi.get(taskId);
    },
    get(id) {
      return rowTask(db.prepare("SELECT * FROM tasks WHERE id=?").get(id));
    },
    list({ storyId, status, assigned } = {}) {
      const where = [];
      const args = [];
      if (storyId)  { where.push("story_id=?"); args.push(storyId); }
      if (status)   { where.push("status=?");   args.push(status); }
      if (assigned) { where.push("assigned=?"); args.push(assigned); }
      const sql = `SELECT * FROM tasks${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC`;
      return db.prepare(sql).all(...args).map(rowTask);
    },
    update(id, patch) {
      const existing = taskApi.get(id);
      if (!existing) throw new Error(`task not found: ${id}`);
      if (patch.status && !TASK_STATUSES.includes(patch.status)) throw new Error(`invalid task status: ${patch.status}`);
      const merged = {
        ...existing,
        ...patch,
        capabilities: patch.capabilities !== undefined ? patch.capabilities : existing.capabilities,
        execution_args: patch.execution_args !== undefined ? patch.execution_args : existing.execution_args,
        updated_at: now(),
      };
      if (patch.status && TASK_TERMINAL.has(patch.status) && !existing.closed_at) merged.closed_at = merged.updated_at;
      const statusChanged = patch.status != null && patch.status !== existing.status;
      // Gate metadata is a function of the blocked state alone: entering
      // stamps it (gateType from the patch or the row's existing value), any
      // exit clears it — a task outside 'blocked' never carries gate fields.
      if (merged.status === "blocked" && existing.status !== "blocked") {
        merged.gate_type = patch.gateType !== undefined ? patch.gateType : existing.gate_type;
        merged.blocked_at = now();
      } else if (existing.status === "blocked" && merged.status !== "blocked") {
        merged.gate_type = null;
        merged.blocked_at = null;
      } else {
        merged.gate_type = patch.gateType !== undefined ? patch.gateType : existing.gate_type;
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`
          UPDATE tasks SET title=?, description=?, status=?, execution_kind=?, execution_args=?, capabilities=?, assigned=?,
                           flow_id=?, task_run_id=?, claim_expires_at=?, lease_seconds=?, last_heartbeat=?, attempt_count=?,
                           gate_type=?, blocked_at=?,
                           result_summary=?, updated_at=?, claimed_at=?, closed_at=?
          WHERE id=?
        `).run(
          merged.title, merged.description, merged.status, merged.execution_kind,
          JSON.stringify(merged.execution_args ?? {}), jsonOut(merged.capabilities), merged.assigned,
          merged.flow_id, merged.task_run_id, merged.claim_expires_at,
          merged.lease_seconds, merged.last_heartbeat, merged.attempt_count,
          merged.gate_type, merged.blocked_at,
          merged.result_summary, merged.updated_at, merged.claimed_at, merged.closed_at,
          id
        );
        if (statusChanged) {
          insertEvent({
            taskId: id,
            fromStatus: existing.status,
            toStatus: merged.status,
            kind: kindForUpdate(existing, merged),
            actor: patch.actor ?? "system",
            note: patch.note ?? null,
            at: merged.updated_at,
            // Callers that carry a stamped identity pass it through so
            // completion (and any future transition) lands attributed.
            // Absent key keeps the legacy null — no silent defaulting.
            sessionRef: patch.sessionKey ?? null,
          });
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return taskApi.get(id);
    },
    delete(id) {
      const r = db.prepare("DELETE FROM tasks WHERE id=?").run(id);
      return r.changes > 0;
    },
    /**
     * Open a human gate: CAS working states (todo|in_progress) → blocked with
     * gate_type stamped, event row in the same transaction. Null if terminal or
     * already blocked — a gate opens exactly once; the event trail is the audit.
     */
    openGate({ id, gateType, reason, actor = "system" }) {
      const t = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const cur = db.prepare("SELECT status FROM tasks WHERE id=?").get(id);
        if (!cur || (cur.status !== "todo" && cur.status !== "in_progress")) {
          db.exec("ROLLBACK");
          return null;
        }
        db.prepare(`
          UPDATE tasks SET status='blocked', gate_type=?, blocked_at=?, updated_at=?
          WHERE id=? AND status IN ('todo','in_progress')
        `).run(gateType, t, t, id);
        insertEvent({
          taskId: id, fromStatus: cur.status, toStatus: "blocked", kind: "gate.opened", actor,
          note: `gate open: ${gateType}${reason ? ` — ${reason}` : ""}`, at: t,
        });
        db.exec("COMMIT");
        return taskApi.get(id);
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    /**
     * Operator resolution of a gate: CAS blocked → todo with claim fields and
     * gate metadata cleared, so the task re-enters the queue for a fresh claim.
     * Null when not blocked — one resume per gate, or the event trail lies.
     */
    resumeGate({ id, actor = "operator" }) {
      const t = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const cur = db.prepare("SELECT status FROM tasks WHERE id=?").get(id);
        if (!cur || cur.status !== "blocked") {
          db.exec("ROLLBACK");
          return null;
        }
        db.prepare(`
          UPDATE tasks SET status='todo', assigned=NULL, claimed_at=NULL, claim_expires_at=NULL,
                           gate_type=NULL, blocked_at=NULL, updated_at=?
          WHERE id=? AND status='blocked'
        `).run(t, id);
        insertEvent({ taskId: id, fromStatus: "blocked", toStatus: "todo", kind: "gate.resolved", actor, note: "gate resume", at: t });
        db.exec("COMMIT");
        return taskApi.get(id);
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    /**
     * CAS claim. Returns the claimed task with a `.lastEvent` property (the
     * event row written in the same transaction), or null if the task wasn't
     * claimable (already in_progress, wrong assignee, terminal, etc.).
     * Claim and its event row are one transaction — splitting them lets the
     * sweeper re-release a task whose claim event never landed.
     */
    claim({ id, agentId, watchdogMs = null, sessionKey }) {
      const t = now();
      const leaseMs = watchdogMs ?? cfg.leaseSeconds * 1000;
      const expires = t + leaseMs;
      const leaseSeconds = Math.floor(leaseMs / 1000);
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = db.prepare(`
          UPDATE tasks SET status='in_progress', assigned=?, claimed_at=?, claim_expires_at=?, lease_seconds=?, last_heartbeat=?, updated_at=?
          WHERE id=? AND status='todo' AND (assigned IS NULL OR assigned=?)
        `).run(agentId, t, expires, leaseSeconds, t, t, id, agentId);
        if (r.changes === 0) { db.exec("ROLLBACK"); return null; }
        const eventsId = insertEvent({
          taskId: id, fromStatus: "todo", toStatus: "in_progress", kind: "task.claimed",
          actor: agentId, note: "claim", at: t, sessionRef: sessionKey ?? null,
        });
        db.exec("COMMIT");
        const task = taskApi.get(id);
        task.lastEvent = rowEvent(db.prepare("SELECT * FROM events WHERE id=?").get(eventsId));
        return task;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    /**
     * Prove liveness mid-task: push last_heartbeat forward. No event row —
     * heartbeats fire too often to pollute the audit trail.
     */
    heartbeat(id, agentId) {
      const t = now();
      // A heartbeat renews the lease, not just the liveness timestamp: an
      // agent actively reporting progress must never read as a corpse. The
      // sweeper keeps sole authority to end a claim — but only for silence.
      // lease_seconds is per-task seconds; legacy rows without one fall back
      // to the claim default of 30 minutes.
      const r = db.prepare(`
        UPDATE tasks SET last_heartbeat=?, updated_at=?, claim_expires_at=?+COALESCE(lease_seconds*1000, ?) WHERE id=? AND status='in_progress' AND assigned=?
      `).run(t, t, t, cfg.leaseSeconds * 1000, id, agentId);
      if (r.changes === 0) return null;
      return taskApi.get(id);
    },
    /**
     * Release a claim — task goes back to 'todo', assignment cleared,
     * attempt_count incremented. Returns the task with `.lastEvent`, or null
     * if it wasn't in_progress. `note`/`at` are for sweepExpired's reuse of
     * this path; external callers just pass id.
     */
    release(id, note = "release", at = now()) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = db.prepare(`
          UPDATE tasks SET status='todo', assigned=NULL, claimed_at=NULL, claim_expires_at=NULL, attempt_count=attempt_count+1, updated_at=?
          WHERE id=? AND status='in_progress'
        `).run(at, id);
        if (r.changes === 0) { db.exec("ROLLBACK"); return null; }
        const eventsId = insertEvent({
          taskId: id, fromStatus: "in_progress", toStatus: "todo", kind: "task.released",
          actor: null, note, at,
        });
        db.exec("COMMIT");
        const task = taskApi.get(id);
        task.lastEvent = rowEvent(db.prepare("SELECT * FROM events WHERE id=?").get(eventsId));
        return task;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    /**
     * Re-release every in_progress task whose claim expired before `now`
     * (same release path, note 'sweeper'). Once a task's attempt_count
     * reaches MAX_ATTEMPTS it escalates to 'blocked' instead of cycling.
     * Returns the affected tasks in their post-sweep state.
     */
    sweepExpired({ now: at = Date.now() } = {}) {
      const expired = db.prepare(
        "SELECT id FROM tasks WHERE status='in_progress' AND claim_expires_at < ?"
      ).all(at);
      const swept = [];
      for (const { id } of expired) {
        const task = taskApi.release(id, "sweeper", at);
        if (!task) continue; // lost a race with a concurrent claim/release
        if (task.attempt_count >= cfg.maxAttempts) {
          db.exec("BEGIN IMMEDIATE");
          try {
            const r = db.prepare(`
              UPDATE tasks SET status='blocked', updated_at=? WHERE id=? AND status='todo'
            `).run(at, id);
            if (r.changes > 0) {
              insertEvent({
                taskId: id, fromStatus: "todo", toStatus: "blocked", kind: "task.blocked",
                actor: "sweeper", note: "blocked: max attempts", at,
              });
            }
            db.exec("COMMIT");
          } catch (err) {
            db.exec("ROLLBACK");
            throw err;
          }
          swept.push(taskApi.get(id));
        } else {
          swept.push(task);
        }
      }
      return swept;
    },
    /**
     * Age-threshold events for unanswered gates: one row per gate per level
     * (24h, 72h), each written once — dedupe is the exact note after
     * blocked_at, so reruns and restarts never double-page. Kind stamped at
     * write, like every producer. Only gates with a blocked_at stamp
     * age-track; legacy rows without one stay silent.
     * Returns the rows written ({taskId, label, eventId}).
     */
    recordGateWaits({ now: at = Date.now(), levels = null } = {}) {
      const lv = levels ?? cfg.gateWaitLevels;
      const gates = db.prepare(
        "SELECT id, blocked_at FROM tasks WHERE status='blocked' AND gate_type IS NOT NULL AND blocked_at IS NOT NULL"
      ).all();
      const written = [];
      for (const g of gates) {
        const age = at - g.blocked_at;
        for (const { ms, label } of lv) {
          if (age < ms) continue;
          const note = `gate waiting: ${label} unanswered`;
          const dup = db.prepare(
            "SELECT 1 FROM events WHERE task_id=? AND note=? AND at>? LIMIT 1"
          ).get(g.id, note, g.blocked_at);
          if (dup) continue;
          const eventId = insertEvent({
            taskId: g.id, fromStatus: "blocked", toStatus: "blocked", kind: "gate.waiting",
            actor: "watcher", note, at,
          });
          written.push({ taskId: g.id, label, eventId });
        }
      }
      return written;
    },
  };

  // ────────────────────────────────────────────────────────────── DEPS
  const depApi = {
    /**
     * Add edge: `from depends on to`. Both sides must already exist.
     * Caller MUST cycle-check before calling (see deps.js).
     */
    addRaw({ fromId, fromKind, toId, toKind }) {
      db.prepare(`
        INSERT INTO deps(from_id, from_kind, to_id, to_kind, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(from_id, to_id) DO NOTHING
      `).run(fromId, fromKind, toId, toKind, now());
      return db.prepare("SELECT * FROM deps WHERE from_id=? AND to_id=?").get(fromId, toId);
    },
    remove({ fromId, toId }) {
      const r = db.prepare("DELETE FROM deps WHERE from_id=? AND to_id=?").run(fromId, toId);
      return r.changes > 0;
    },
    listOutgoing(fromId) {
      return db.prepare("SELECT * FROM deps WHERE from_id=?").all(fromId);
    },
    listIncoming(toId) {
      return db.prepare("SELECT * FROM deps WHERE to_id=?").all(toId);
    },
    all() {
      return db.prepare("SELECT * FROM deps").all();
    },
  };

  // ──────────────────────────────────────────────────── WEBHOOK TARGETS
  // One callback URL per harness, registered via `winch webhook set`.
  // Checked first at claim time (see claim-webhook.js), before the env-mapped
  // and single-URL config. Bearer is stored as given — protect the DB file
  // the way you protect env files (0600, owned volume).
  const webhookApi = {
    upsert({ harness, url, bearer = null, timeoutMs = null }) {
      const h = typeof harness === "string" ? harness.trim() : "";
      if (!h) throw new Error("webhook target requires a harness");
      let u;
      try {
        u = new URL(url);
      } catch {
        throw new Error(`invalid webhook url: ${JSON.stringify(url)}`);
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error(`webhook url must be http(s): ${JSON.stringify(url)}`);
      }
      if (timeoutMs != null && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
        throw new Error(`webhook timeoutMs must be a positive integer, got ${JSON.stringify(timeoutMs)}`);
      }
      const t = now();
      db.prepare(`
        INSERT INTO webhook_targets(harness, url, bearer, timeout_ms, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(harness) DO UPDATE SET url=excluded.url, bearer=excluded.bearer,
          timeout_ms=excluded.timeout_ms, updated_at=excluded.updated_at
      `).run(h, u.toString(), bearer ?? null, timeoutMs ?? null, t, t);
      return webhookApi.get(h);
    },
    remove({ harness }) {
      const r = db.prepare("DELETE FROM webhook_targets WHERE harness=?").run(harness);
      return r.changes > 0;
    },
    list() {
      return db.prepare("SELECT * FROM webhook_targets ORDER BY harness ASC").all();
    },
    get(harness) {
      const r = db.prepare("SELECT * FROM webhook_targets WHERE harness=?").get(harness);
      if (!r) return null;
      return { harness: r.harness, url: r.url, bearer: r.bearer, timeoutMs: r.timeout_ms };
    },
  };

  // ──────────────────────────────────────────────────── EXISTENCE / KIND
  function itemKindOf(id) {
    const cls = classifyId(id);
    if (!cls) return null;
    const row = ({ epic: epicApi.get, story: storyApi.get, task: taskApi.get })[cls](id);
    return row ? cls : null;
  }

  return {
    db,
    orm,
    path: finalPath,
    config: cfg,
    epic:  epicApi,
    story: storyApi,
    task:  taskApi,
    dep:   depApi,
    webhook: webhookApi,
    itemKindOf,
    close() { db.close(); },
  };
}
