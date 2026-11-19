// Shared context for the store modules: the SQL projection, row decoration,
// event/session/attempt primitives, and the status vocabulary. `createStore`
// owns the database handle; everything here closes over it.

import { newAttemptId, newSessionId } from "../ids.js";
import {
  EPIC_STATUSES,
  STORY_STATUSES,
  TASK_STATUSES,
  EXECUTION_KINDS,
  ITEM_KINDS,
} from "../schema.js";

export const MAX_ATTEMPTS = 3;

export const STATUSES_BY_KIND = { epic: EPIC_STATUSES, story: STORY_STATUSES, task: TASK_STATUSES };
export const DEFAULT_STATUS = { epic: "backlog", story: "backlog", task: "backlog" };
export const ITEM_TERMINAL = new Set(["done", "cancelled"]);

export const ITEM_SELECT = `
  SELECT i.id, i.kind, i.parent_id, i.child_key, i.visit_seq, i.title, i.description,
         i.acceptance, i.priority, i.size, i.owner_team, i.created_by,
         i.execution_kind, i.execution_args, i.created_at,
         s.revision, s.status, s.state_json, s.wait_kind, s.current_child_key,
         s.assignee_harness, s.assignee_agent,
         s.updated_at, s.closed_at, s.deleted_at
    FROM items i JOIN item_state s ON s.item_id = i.id`;

export function now() { return Date.now(); }
export function jsonOut(v) { return v == null ? null : JSON.stringify(v); }
export function jsonIn(v) { if (v == null) return null; try { return JSON.parse(v); } catch { return null; } }
export function splitSessionKey(key) {
  if (typeof key !== "string") return null;
  const parts = key.split(":");
  if (parts.length < 3) return null;
  return { harness: parts[0], agent: parts[1], session: parts.slice(2).join(":") };
}

export function createCore({ db, cfg }) {
  let eventHook = null;

  function ancestors(id) {
    const rows = db.prepare(`
      WITH RECURSIVE up(id, kind, parent_id, depth) AS (
        SELECT id, kind, parent_id, 0 FROM items WHERE id = ?
        UNION ALL
        SELECT i.id, i.kind, i.parent_id, up.depth + 1
          FROM items i JOIN up ON i.id = up.parent_id
         WHERE up.depth < 64
      )
      SELECT id, kind FROM up ORDER BY depth ASC
    `).all(id);
    return rows;
  }

  function decorate(r, { includeDeleted = false } = {}) {
    if (!r) return null;
    if (!includeDeleted && r.deleted_at != null) return null;
    const tags = db.prepare("SELECT tag FROM item_tags WHERE item_id=? ORDER BY tag ASC").all(r.id).map((t) => t.tag);
    const live = db.prepare(
      "SELECT * FROM attempts WHERE item_id=? AND ended_at IS NULL ORDER BY attempt_no DESC LIMIT 1"
    ).get(r.id);
    const latest = live ?? db.prepare(
      "SELECT * FROM attempts WHERE item_id=? ORDER BY attempt_no DESC LIMIT 1"
    ).get(r.id);
    const count = db.prepare("SELECT COALESCE(MAX(attempt_no),0) AS n FROM attempts WHERE item_id=?").get(r.id).n;
    const gated = r.status === "blocked"
      ? db.prepare("SELECT * FROM attempts WHERE item_id=? AND gate_record_json IS NOT NULL ORDER BY attempt_no DESC LIMIT 1").get(r.id)
      : null;
    const chain = ancestors(r.id);
    const story = r.kind === "task" ? chain.find((a) => a.kind === "story") : null;
    const epic = r.kind === "epic" ? { id: r.id } : chain.find((a) => a.kind === "epic");
    return {
      ...r,
      state_json: jsonIn(r.state_json) ?? {},
      execution_args: jsonIn(r.execution_args) ?? {},
      capabilities: tags,
      assigned: r.assignee_agent ?? null,
      attempt_count: count,
      claimed_at: live?.claimed_at ?? null,
      claim_expires_at: live?.expires_at ?? null,
      lease_seconds: live?.lease_seconds ?? latest?.lease_seconds ?? null,
      last_heartbeat: live?.heartbeat_at ?? latest?.heartbeat_at ?? null,
      gate_type: gated?.gate_type ?? null,
      blocked_at: gated?.ended_at ?? null,
      result_summary: latest?.result_summary ?? null,
      flow_id: null,
      task_run_id: null,
      story_id: story?.id ?? null,
      epic_id: epic?.id ?? null,
      attempt_id: live?.id ?? latest?.id ?? null,
      session_id: live?.session_id ?? latest?.session_id ?? null,
    };
  }

  function getRow(id, { includeDeleted = false } = {}) {
    return decorate(db.prepare(`${ITEM_SELECT} WHERE i.id=?`).get(id), { includeDeleted });
  }

  function listRows({ kind = null, parentId, status = null, assigned = null, assignedHarness = null, includeDeleted = false } = {}) {
    const where = [];
    const args = [];
    if (kind) { where.push("i.kind=?"); args.push(kind); }
    if (parentId !== undefined) { where.push("i.parent_id=?"); args.push(parentId); }
    if (status) { where.push("s.status=?"); args.push(status); }
    if (assigned) { where.push("s.assignee_agent=?"); args.push(assigned); }
    if (assignedHarness) { where.push("s.assignee_harness=?"); args.push(assignedHarness); }
    if (!includeDeleted) where.push("s.deleted_at IS NULL");
    const order = kind === "task"
      ? "i.created_at ASC"
      : "i.priority DESC, i.created_at ASC";
    const sql = `${ITEM_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order}`;
    return db.prepare(sql).all(...args).map((r) => decorate(r, { includeDeleted }));
  }

  function appendEvent({ itemId, attemptId = null, sessionId = null, fromStatus = null, toStatus, kind = null, actor = null, note = null, payload = null, at = null }) {
    const r = db.prepare(`
      INSERT INTO item_events(item_id, attempt_id, session_id, from_status, to_status, kind, actor, note, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(itemId, attemptId, sessionId, fromStatus, toStatus, kind, actor, note, jsonOut(payload), at ?? now());
    const id = Number(r.lastInsertRowid);
    // Runs inside the caller's transaction, so a status write and its wake
    // admission commit or roll back together.
    if (eventHook) eventHook(id);
    return id;
  }

  function eventById(id) {
    return db.prepare("SELECT * FROM item_events WHERE id=?").get(id) ?? null;
  }

  function eventsFor(itemId, limit = null) {
    const sql = `SELECT * FROM item_events WHERE item_id=? ORDER BY id DESC${limit ? " LIMIT ?" : ""}`;
    const rows = limit ? db.prepare(sql).all(itemId, limit) : db.prepare(sql).all(itemId);
    return limit ? rows : rows.reverse();
  }

  function kindForTransition(kind, fromStatus, toStatus, gateType) {
    if (fromStatus == null) return `${kind}.created`;
    if (toStatus === "blocked") return gateType ? "gate.opened" : `${kind}.blocked`;
    if (fromStatus === "blocked" && toStatus === "ready") return gateType ? "gate.dissolved" : `${kind}.released`;
    if (toStatus === "done") return `${kind}.completed`;
    if (toStatus === "cancelled") return `${kind}.cancelled`;
    if (kind === "task" && fromStatus === "ready" && toStatus === "in_progress") return "task.claimed";
    if (toStatus === "ready") return `${kind}.released`;
    return `${kind}.updated`;
  }

  function ensureSession({ harness, agentId, externalSessionId, itemId, kind = "claim", parentSessionId = null }) {
    const existing = db.prepare(
      "SELECT * FROM work_sessions WHERE harness=? AND agent_id=? AND external_session_id=?"
    ).get(harness, agentId, externalSessionId);
    if (existing) {
      const parent = existing.parent_session_id ?? parentSessionId ?? null;
      const nextKind = parent ? "fanout" : existing.kind;
      db.prepare("UPDATE work_sessions SET item_id=?, parent_session_id=?, kind=? WHERE id=?")
        .run(itemId, parent, nextKind, existing.id);
      return db.prepare("SELECT * FROM work_sessions WHERE id=?").get(existing.id);
    }
    const id = newSessionId();
    db.prepare(`
      INSERT INTO work_sessions(id, item_id, harness, agent_id, external_session_id, kind, parent_session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, itemId, harness, agentId, externalSessionId, parentSessionId ? "fanout" : kind, parentSessionId, now());
    return db.prepare("SELECT * FROM work_sessions WHERE id=?").get(id);
  }

  function systemSession(itemId) {
    return ensureSession({ harness: "system", agentId: "system", externalSessionId: "system", itemId, kind: "system" });
  }

  function liveAttempt(itemId) {
    return db.prepare("SELECT * FROM attempts WHERE item_id=? AND ended_at IS NULL ORDER BY attempt_no DESC LIMIT 1").get(itemId) ?? null;
  }

  function endAttempt(attemptId, { status, endedAt = now(), result = null, errorType = null, gateRecord = null } = {}) {
    db.prepare(`
      UPDATE attempts SET status=?, ended_at=?, result_json=COALESCE(?, result_json),
                         error_type=COALESCE(?, error_type), gate_record_json=COALESCE(?, gate_record_json)
       WHERE id=?
    `).run(status, endedAt, jsonOut(result), errorType, jsonOut(gateRecord), attemptId);
  }

  function createAttempt({ itemId, sessionId, status = "running", claimedAt = now(), leaseSeconds, result = null, errorType = null, gateRecord = null, endedAt = null, consumerId = null, ownerInstance = null, leaseEpoch = 0 }) {
    const no = db.prepare("SELECT COALESCE(MAX(attempt_no),0)+1 AS n FROM attempts WHERE item_id=?").get(itemId).n;
    const id = newAttemptId();
    db.prepare(`
      INSERT INTO attempts(id, item_id, attempt_no, session_id, status, claimed_at, heartbeat_at,
                           lease_seconds, ended_at, result_json, error_type, gate_record_json,
                           consumer_id, owner_instance, lease_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, itemId, no, sessionId, status, claimedAt, status === "gated" ? null : claimedAt,
      leaseSeconds, endedAt, jsonOut(result), errorType, jsonOut(gateRecord), consumerId, ownerInstance, leaseEpoch);
    return db.prepare("SELECT * FROM attempts WHERE id=?").get(id);
  }

  return {
    db,
    cfg,
    ITEM_SELECT,
    STATUSES_BY_KIND,
    DEFAULT_STATUS,
    ITEM_TERMINAL,
    now,
    jsonIn,
    jsonOut,
    splitSessionKey,
    ancestors,
    decorate,
    getRow,
    listRows,
    appendEvent,
    setEventHook(fn) { eventHook = fn; },
    eventById,
    eventsFor,
    kindForTransition,
    ensureSession,
    systemSession,
    liveAttempt,
    endAttempt,
    createAttempt,
  };
}

export { EPIC_STATUSES, STORY_STATUSES, TASK_STATUSES, EXECUTION_KINDS, ITEM_KINDS };
