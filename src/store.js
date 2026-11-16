// store.js — v8 data layer over better-sqlite3.
//
// One recursive `items` table holds epics, stories and tasks; `item_state`
// carries the mutable half, `attempts` one row per claim, `work_sessions` the
// actor, `item_events` the append-only ledger. The `epic`/`story`/`task`
// facades below preserve the tool-facing method names on top of that model.
//
// Concurrency: WAL mode enabled. CLI and gateway processes can read/write the
// same DB concurrently; sqlite serializes the writes. Every multi-row
// transition (claim + attempt + event, gate + event, drop) runs inside one
// BEGIN IMMEDIATE transaction.

import {
  newItemId,
  newAttemptId,
  newSessionId,
  newArtifactId,
} from "./ids.js";
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

// A task that exhausts this many attempts escalates to 'blocked' instead of
// cycling; claim/release and sweepExpired both read it.
export const MAX_ATTEMPTS = 3;

export { EPIC_STATUSES, STORY_STATUSES, TASK_STATUSES, EXECUTION_KINDS, ITEM_KINDS };

const STATUSES_BY_KIND = { epic: EPIC_STATUSES, story: STORY_STATUSES, task: TASK_STATUSES };
const DEFAULT_STATUS = { epic: "idea", story: "backlog", task: "todo" };
const TERMINAL = new Set(["done", "cancelled"]);
const ITEM_TERMINAL = TERMINAL;

function now() { return Date.now(); }
function jsonOut(v) { return v == null ? null : JSON.stringify(v); }
function jsonIn(v) { if (v == null) return null; try { return JSON.parse(v); } catch { return null; } }
function splitSessionKey(key) {
  if (typeof key !== "string") return null;
  const parts = key.split(":");
  if (parts.length < 3) return null;
  return { harness: parts[0], agent: parts[1], session: parts.slice(2).join(":") };
}

const ITEM_SELECT = `
  SELECT i.id, i.kind, i.parent_id, i.title, i.description,
         i.acceptance, i.priority, i.size, i.owner_team, i.created_by,
         i.execution_kind, i.execution_args, i.created_at,
         s.revision, s.status, s.state_json, s.assignee_harness, s.assignee_agent,
         s.updated_at, s.closed_at, s.deleted_at
    FROM items i JOIN item_state s ON s.item_id = i.id`;

export function createStore({ dbPath, logger, config: explicitConfig } = {}) {
  const finalPath = dbPath || resolveDbPath();
  const { sqlite: db, orm } = openDatabase({ dbPath: finalPath, logger });
  const cfg = resolveConfig({ explicit: explicitConfig ?? {} });

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

  // ────────────────────────────────────────────────────────────── EVENTS
  function appendEvent({ itemId, attemptId = null, sessionId = null, fromStatus = null, toStatus, kind = null, actor = null, note = null, payload = null, at = null }) {
    const r = db.prepare(`
      INSERT INTO item_events(item_id, attempt_id, session_id, from_status, to_status, kind, actor, note, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(itemId, attemptId, sessionId, fromStatus, toStatus, kind, actor, note, jsonOut(payload), at ?? now());
    return Number(r.lastInsertRowid);
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
    if (fromStatus === "blocked" && toStatus === "todo") return gateType ? "gate.dissolved" : `${kind}.released`;
    if (toStatus === "done") return `${kind}.completed`;
    if (toStatus === "cancelled") return `${kind}.cancelled`;
    if (kind === "task" && fromStatus === "todo" && toStatus === "in_progress") return "task.claimed";
    if (toStatus === "todo") return `${kind}.released`;
    return `${kind}.updated`;
  }

  // ────────────────────────────────────────────────────────────── SESSIONS
  function ensureSession({ harness, agentId, externalSessionId, itemId, kind = "claim" }) {
    const existing = db.prepare(
      "SELECT * FROM work_sessions WHERE harness=? AND agent_id=? AND external_session_id=?"
    ).get(harness, agentId, externalSessionId);
    if (existing) {
      db.prepare("UPDATE work_sessions SET item_id=? WHERE id=?").run(itemId, existing.id);
      return db.prepare("SELECT * FROM work_sessions WHERE id=?").get(existing.id);
    }
    const id = newSessionId();
    db.prepare(`
      INSERT INTO work_sessions(id, item_id, harness, agent_id, external_session_id, kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, itemId, harness, agentId, externalSessionId, kind, now());
    return db.prepare("SELECT * FROM work_sessions WHERE id=?").get(id);
  }

  function systemSession(itemId) {
    return ensureSession({ harness: "system", agentId: "system", externalSessionId: "system", itemId, kind: "system" });
  }

  // ────────────────────────────────────────────────────────────── ITEMS
  const itemApi = {
    create(input = {}) {
      const kind = input.kind;
      if (!ITEM_KINDS.includes(kind)) throw new Error(`invalid item kind: ${kind}`);
      const id = input.id || newItemId();
      const status = input.status || DEFAULT_STATUS[kind];
      if (!STATUSES_BY_KIND[kind].includes(status)) throw new Error(`invalid ${kind} status: ${status}`);
      const executionKind = input.executionKind ?? "manual";
      if (!EXECUTION_KINDS.includes(executionKind)) throw new Error(`invalid execution_kind: ${executionKind}`);
      const parentId = kind === "epic" ? null : (input.parentId ?? null);
      if (kind !== "epic" && !parentId) throw new Error(`${kind} requires a parentId`);
      if (parentId) {
        const parent = db.prepare("SELECT kind FROM items WHERE id=?").get(parentId);
        if (!parent) throw new Error(`parent not found: ${parentId}`);
        if (kind === "story" && parent.kind !== "epic") throw new Error(`story parent must be an epic: ${parentId}`);
        if (kind === "task" && parent.kind !== "story" && parent.kind !== "task") throw new Error(`task parent must be a story or task: ${parentId}`);
      }
      const t = input.createdAt ?? now();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`
          INSERT INTO items(id, kind, parent_id, title, description, acceptance,
                            priority, size, owner_team, created_by, execution_kind, execution_args, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, kind, parentId, input.title,
          input.description ?? null, input.acceptance ?? null,
          input.priority ?? 50, input.size ?? null, input.ownerTeam ?? null,
          input.createdBy ?? null, executionKind, JSON.stringify(input.executionArgs ?? {}), t,
        );
        db.prepare(`
          INSERT INTO item_state(item_id, revision, status, state_json, assignee_harness, assignee_agent, updated_at, closed_at, deleted_at)
          VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, status, JSON.stringify(input.state ?? {}),
          input.assigneeHarness ?? null, input.assigneeAgent ?? null,
          t, ITEM_TERMINAL.has(status) ? t : null, null,
        );
        for (const tag of input.capabilities ?? []) {
          db.prepare("INSERT OR IGNORE INTO item_tags(item_id, tag, source, created_at) VALUES (?, ?, ?, ?)")
            .run(id, String(tag), input.tagSource ?? "assign", t);
        }
        if (input.emit !== false) {
          appendEvent({
            itemId: id,
            fromStatus: null,
            toStatus: status,
            kind: `${kind}.created`,
            actor: input.actor ?? null,
            note: input.note ?? `${kind} created`,
            at: t,
          });
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return itemApi.get(id, { includeDeleted: true });
    },

    get(id, opts = {}) { return getRow(id, opts); },

    list(opts = {}) { return listRows(opts); },

    children(id) {
      return db.prepare(`${ITEM_SELECT} WHERE i.parent_id=? AND s.deleted_at IS NULL ORDER BY i.created_at ASC`)
        .all(id).map((r) => decorate(r));
    },

    tree(id, { includeDeleted = false } = {}) {
      const rows = db.prepare(`
        WITH RECURSIVE down(id, depth) AS (
          SELECT id, 0 FROM items WHERE id=?
          UNION ALL
          SELECT i.id, down.depth + 1 FROM items i JOIN down ON i.parent_id = down.id WHERE down.depth < 64
        )
        SELECT i.id FROM down JOIN items i ON i.id=down.id ORDER BY down.depth ASC
      `).all(id);
      return rows.map((r) => itemApi.get(r.id, { includeDeleted })).filter(Boolean);
    },

    update(id, patch = {}) {
      const existing = getRow(id, { includeDeleted: true });
      if (!existing) throw new Error(`item not found: ${id}`);
      const status = patch.status ?? existing.status;
      if (!STATUSES_BY_KIND[existing.kind].includes(status)) throw new Error(`invalid ${existing.kind} status: ${status}`);
      const executionKind = patch.executionKind ?? existing.execution_kind;
      if (!EXECUTION_KINDS.includes(executionKind)) throw new Error(`invalid execution_kind: ${executionKind}`);
      const t = patch.updatedAt ?? now();
      const next = {
        title: patch.title ?? existing.title,
        description: patch.description !== undefined ? patch.description : existing.description,
        acceptance: patch.acceptance !== undefined ? patch.acceptance : existing.acceptance,
        priority: patch.priority ?? existing.priority,
        size: patch.size !== undefined ? patch.size : existing.size,
        owner_team: patch.ownerTeam !== undefined ? patch.ownerTeam : existing.owner_team,
        created_by: patch.createdBy !== undefined ? patch.createdBy : existing.created_by,
        execution_kind: executionKind,
        execution_args: patch.executionArgs !== undefined ? patch.executionArgs : existing.execution_args,
        assignee_harness: patch.assigneeHarness !== undefined ? patch.assigneeHarness : existing.assignee_harness,
        assignee_agent: patch.assigneeAgent !== undefined ? patch.assigneeAgent : existing.assignee_agent,
        state_json: patch.state !== undefined ? patch.state : existing.state_json,
        closed_at: patch.closedAt !== undefined ? patch.closedAt : existing.closed_at,
        deleted_at: patch.deletedAt !== undefined ? patch.deletedAt : existing.deleted_at,
      };
      if (patch.assigned !== undefined) next.assignee_agent = patch.assigned ?? null;
      if (next.assignee_agent == null) next.assignee_harness = null;
      else if (next.assignee_harness == null) next.assignee_harness = patch.harness ?? "legacy";
      if (patch.status && ITEM_TERMINAL.has(status) && !existing.closed_at) next.closed_at = t;
      if (patch.status && !ITEM_TERMINAL.has(status) && existing.closed_at && patch.closedAt === undefined) next.closed_at = null;
      if ((next.assignee_harness == null) !== (next.assignee_agent == null)) {
        throw new Error(`assignment is a pair: ${id}`);
      }
      const statusChanged = status !== existing.status;
      const note = patch.note ?? null;
      const actor = patch.actor ?? (statusChanged ? "system" : null);
      const kind = patch.kind ?? kindForTransition(existing.kind, existing.status, status, existing.gate_type);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`
          UPDATE items SET title=?, description=?, acceptance=?, priority=?, size=?, owner_team=?,
                           created_by=?, execution_kind=?, execution_args=?
           WHERE id=?
        `).run(next.title, next.description, next.acceptance, next.priority, next.size, next.owner_team,
          next.created_by, next.execution_kind, JSON.stringify(next.execution_args ?? {}), id);
        db.prepare(`
          UPDATE item_state SET revision=revision+1, status=?, state_json=?, assignee_harness=?, assignee_agent=?,
                                updated_at=?, closed_at=?, deleted_at=?
           WHERE item_id=?
        `).run(status, JSON.stringify(next.state_json ?? {}), next.assignee_harness, next.assignee_agent,
          t, next.closed_at, next.deleted_at, id);
        if (patch.capabilities !== undefined) {
          db.prepare("DELETE FROM item_tags WHERE item_id=?").run(id);
          for (const tag of patch.capabilities ?? []) {
            db.prepare("INSERT OR IGNORE INTO item_tags(item_id, tag, source, created_at) VALUES (?, ?, ?, ?)")
              .run(id, String(tag), patch.tagSource ?? "assign", t);
          }
        }
        if (statusChanged || patch.event) {
          appendEvent({
            itemId: id,
            attemptId: patch.attemptId ?? null,
            sessionId: patch.sessionId ?? null,
            fromStatus: existing.status,
            toStatus: status,
            kind,
            actor,
            note,
            payload: patch.payload ?? null,
            at: t,
          });
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return itemApi.get(id, { includeDeleted: true });
    },

    drop(id, { reason = null, actor = null, at = null } = {}) {
      const row = getRow(id, { includeDeleted: true });
      if (!row) return null;
      const descendants = itemApi.tree(id, { includeDeleted: true }).filter((r) => r.id !== id);
      const claimed = descendants.filter((r) => r.kind === "task" && (r.attempt_count > 0 || r.status !== "todo"));
      const t = at ?? now();
      const note = reason ? `dropped: ${String(reason).slice(0, 160)}` : `dropped with ${row.kind}`;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const r of [...descendants, row]) {
          const fresh = getRow(r.id, { includeDeleted: true });
          if (!fresh || fresh.deleted_at != null) continue;
          db.prepare(`
            UPDATE item_state SET revision=revision+1, status='cancelled',
                                  state_json=json_set(state_json, '$.priorStatus', status),
                                  deleted_at=?, closed_at=?, updated_at=?
             WHERE item_id=?
          `).run(t, t, t, r.id);
          appendEvent({
            itemId: r.id,
            fromStatus: fresh.status,
            toStatus: "cancelled",
            kind: r.kind === "task" ? "task.dropped" : `${r.kind}.cancelled`,
            actor, note, at: t,
          });
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return { row, descendants, claimed, at: t };
    },

    restore(id, { actor = null, at = null } = {}) {
      const row = getRow(id, { includeDeleted: true });
      if (!row) return null;
      const t = at ?? now();
      const state = row.state_json && typeof row.state_json === "object" ? row.state_json : jsonIn(row.state_json);
      const prior = state?.priorStatus;
      const status = prior && STATUSES_BY_KIND[row.kind].includes(prior) ? prior : DEFAULT_STATUS[row.kind];
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`
          UPDATE item_state SET revision=revision+1, status=?,
                                state_json=json_remove(state_json, '$.priorStatus'),
                                deleted_at=NULL, closed_at=NULL, updated_at=?
           WHERE item_id=?
        `).run(status, t, id);
        appendEvent({
          itemId: id, fromStatus: row.status, toStatus: status,
          kind: row.kind === "task" ? "task.restored" : `${row.kind}.restored`,
          actor, note: "restored", at: t,
        });
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return itemApi.get(id);
    },

    kindOf(id) {
      const r = db.prepare("SELECT kind FROM items WHERE id=?").get(id);
      return r?.kind ?? null;
    },

    addTags(id, tags, source = "assign") {
      for (const tag of tags ?? []) {
        db.prepare("INSERT OR IGNORE INTO item_tags(item_id, tag, source, created_at) VALUES (?, ?, ?, ?)")
          .run(id, String(tag), source, now());
      }
    },
  };

  // ────────────────────────────────────────────────────────────── ATTEMPTS
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

  function createAttempt({ itemId, sessionId, status = "running", claimedAt = now(), leaseSeconds, result = null, errorType = null, gateRecord = null, endedAt = null }) {
    const no = db.prepare("SELECT COALESCE(MAX(attempt_no),0)+1 AS n FROM attempts WHERE item_id=?").get(itemId).n;
    const id = newAttemptId();
    db.prepare(`
      INSERT INTO attempts(id, item_id, attempt_no, session_id, status, claimed_at, heartbeat_at,
                           lease_seconds, ended_at, result_json, error_type, gate_record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, itemId, no, sessionId, status, claimedAt, status === "gated" ? null : claimedAt,
      leaseSeconds, endedAt, jsonOut(result), errorType, jsonOut(gateRecord));
    return db.prepare("SELECT * FROM attempts WHERE id=?").get(id);
  }

  // ────────────────────────────────────────────────────────────── ATTEMPT API
  const attemptApi = {
    list({ itemId = null, status = null, live = false } = {}) {
      const where = [];
      const args = [];
      if (itemId) { where.push("item_id=?"); args.push(itemId); }
      if (status) { where.push("status=?"); args.push(status); }
      if (live) where.push("ended_at IS NULL");
      return db.prepare(`SELECT * FROM attempts${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY attempt_no DESC`)
        .all(...args);
    },
    get(id) { return db.prepare("SELECT * FROM attempts WHERE id=?").get(id) ?? null; },
    end(id, opts) { endAttempt(id, opts); return attemptApi.get(id); },
  };

  // ────────────────────────────────────────────────────────────── ARTIFACTS
  const artifactApi = {
    add({ itemId, attemptId = null, kind = "link", uri, sha256 = null, label = null }) {
      if (!uri) throw new Error("artifact requires a uri");
      const id = newArtifactId();
      db.prepare(`
        INSERT INTO artifacts(id, item_id, attempt_id, kind, uri, sha256, label, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(uri) DO NOTHING
      `).run(id, itemId, attemptId, kind, uri, sha256, label, now());
      return db.prepare("SELECT * FROM artifacts WHERE uri=?").get(uri) ?? null;
    },
    listFor(itemId) {
      return db.prepare("SELECT * FROM artifacts WHERE item_id=? AND deleted_at IS NULL ORDER BY created_at ASC").all(itemId);
    },
  };

  // ────────────────────────────────────────────────────────────── EPIC FACADE
  const epicApi = {
    create({ title, description, acceptance, status, ownerTeam, priority, id, createdBy }) {
      return itemApi.create({
        id, kind: "epic", title, description, acceptance,
        status: status ?? "idea", ownerTeam, priority,
        createdBy, emit: false,
      });
    },
    get(id) {
      const row = itemApi.get(id);
      return row?.kind === "epic" ? row : null;
    },
    list({ status } = {}) {
      return itemApi.list({ kind: "epic", status });
    },
    update(id, patch) {
      const existing = epicApi.get(id);
      if (!existing) throw new Error(`epic not found: ${id}`);
      return itemApi.update(id, {
        ...patch,
        status: patch.status,
      });
    },
    delete(id) {
      const r = db.prepare("DELETE FROM items WHERE id=? AND kind='epic'").run(id);
      return r.changes > 0;
    },
  };

  // ────────────────────────────────────────────────────────────── STORY FACADE
  const storyApi = {
    create({ epicId, title, description, acceptance, status, size, priority, assigned, capabilities, assigneeHarness, id }) {
      if (!epicApi.get(epicId)) throw new Error(`epic not found: ${epicId}`);
      return itemApi.create({
        id, kind: "story", parentId: epicId, title, description, acceptance,
        status: status ?? "backlog", size, priority, capabilities,
        assigneeAgent: assigned ?? null,
        assigneeHarness: assigned ? (assigneeHarness ?? "legacy") : null,
        emit: false,
      });
    },
    get(id) {
      const row = itemApi.get(id);
      return row?.kind === "story" ? row : null;
    },
    list({ epicId, status, assigned, assignedHarness } = {}) {
      return itemApi.list({ kind: "story", parentId: epicId, status, assigned, assignedHarness });
    },
    update(id, patch) {
      const existing = storyApi.get(id);
      if (!existing) throw new Error(`story not found: ${id}`);
      const next = { ...patch };
      if (patch.assignee_harness !== undefined) next.assigneeHarness = patch.assignee_harness;
      if (patch.assigned !== undefined) next.assigneeAgent = patch.assigned ?? null;
      return itemApi.update(id, next);
    },
    delete(id) {
      const r = db.prepare("DELETE FROM items WHERE id=? AND kind='story'").run(id);
      return r.changes > 0;
    },
  };

  // ────────────────────────────────────────────────────────────── TASK FACADE
  const taskApi = {
    create({ storyId, title, description, status, executionKind, executionArgs, capabilities, assigned, assigneeHarness, id }) {
      const parent = itemApi.get(storyId, { includeDeleted: true });
      if (!parent) throw new Error(`story not found: ${storyId}`);
      if (parent.kind !== "story" && parent.kind !== "task") throw new Error(`task parent must be a story or task: ${storyId}`);
      return itemApi.create({
        id, kind: "task", parentId: storyId, title, description,
        status: status ?? "todo", executionKind: executionKind ?? "manual",
        executionArgs, capabilities,
        assigneeAgent: assigned ?? null,
        assigneeHarness: assigned ? (assigneeHarness ?? "legacy") : null,
        emit: true, note: "task created",
      });
    },
    get(id) {
      const row = itemApi.get(id);
      return row?.kind === "task" ? row : null;
    },
    list({ storyId, status, assigned, assignedHarness } = {}) {
      return itemApi.list({ kind: "task", parentId: storyId, status, assigned, assignedHarness });
    },
    update(id, patch) {
      const existing = taskApi.get(id);
      if (!existing) throw new Error(`task not found: ${id}`);
      if (patch.status && !TASK_STATUSES.includes(patch.status)) throw new Error(`invalid task status: ${patch.status}`);
      const t = patch.updatedAt ?? now();
      const nextStatus = patch.status ?? existing.status;
      const enteringGate = nextStatus === "blocked" && existing.status !== "blocked";
      const leavingBlocked = existing.status === "blocked" && nextStatus !== "blocked";
      const gateType = patch.gateType !== undefined ? patch.gateType : (enteringGate ? existing.gate_type : null);
      const resultSummary = patch.result_summary !== undefined ? patch.result_summary : undefined;
      const hasSession = patch.sessionKey || patch.harness || patch.session;
      const parsed = splitSessionKey(patch.sessionKey);
      let sessionId = patch.sessionId ?? null;
      if (!sessionId && hasSession) {
        const session = ensureSession({
          harness: patch.harness ?? parsed?.harness ?? "system",
          agentId: patch.agentId ?? patch.actor ?? existing.assignee_agent ?? "system",
          externalSessionId: patch.session ?? parsed?.session ?? "system",
          itemId: id,
        });
        sessionId = session.id;
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const live = liveAttempt(id);
        if (enteringGate) {
          const gateRecord = gateType ? { type: gateType, reason: patch.note ?? null, actor: patch.actor ?? null, openedAt: t } : null;
          if (live) {
            endAttempt(live.id, { status: gateRecord ? "gated" : "released", endedAt: t, gateRecord });
          } else if (gateRecord) {
            const session = sessionId ? { id: sessionId } : systemSession(id);
            createAttempt({ itemId: id, sessionId: session.id, status: "gated", claimedAt: t, endedAt: t, leaseSeconds: cfg.leaseSeconds, gateRecord });
          }
        } else if (live && (ITEM_TERMINAL.has(nextStatus) || nextStatus === "todo" || leavingBlocked)) {
          const status = ITEM_TERMINAL.has(nextStatus) ? nextStatus : "released";
          const result = resultSummary !== undefined ? { summary: resultSummary } : null;
          endAttempt(live.id, { status, endedAt: t, result });
        } else if (live && resultSummary !== undefined) {
          db.prepare("UPDATE attempts SET result_json=? WHERE id=?").run(JSON.stringify({ summary: resultSummary }), live.id);
        } else if (!live && (ITEM_TERMINAL.has(nextStatus) || resultSummary !== undefined)) {
          const session = sessionId ? { id: sessionId } : systemSession(id);
          createAttempt({
            itemId: id,
            sessionId: session.id,
            status: ITEM_TERMINAL.has(nextStatus) ? nextStatus : "running",
            claimedAt: existing.claimed_at ?? t,
            endedAt: ITEM_TERMINAL.has(nextStatus) ? (existing.closed_at ?? t) : null,
            leaseSeconds: cfg.leaseSeconds,
            result: resultSummary !== undefined ? { summary: resultSummary } : null,
          });
        }
        if (leavingBlocked) {
          // A gate exit clears the pair unless the caller re-assigns in the same call.
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      const row = itemApi.update(id, {
        status: patch.status,
        title: patch.title,
        description: patch.description,
        acceptance: patch.acceptance,
        priority: patch.priority,
        size: patch.size,
        ownerTeam: patch.ownerTeam,
        executionKind: patch.execution_kind ?? patch.executionKind,
        executionArgs: patch.execution_args ?? patch.executionArgs,
        assigneeHarness: patch.assignee_harness !== undefined ? patch.assignee_harness : (leavingBlocked && patch.assigned === null ? null : undefined),
        assigneeAgent: patch.assigned !== undefined ? patch.assigned : (leavingBlocked && patch.assigned === null ? null : undefined),
        capabilities: patch.capabilities,
        actor: patch.actor ?? null,
        note: patch.note ?? null,
        sessionId,
        kind: patch.kind ?? (enteringGate ? (gateType ? "gate.opened" : "task.blocked") : (leavingBlocked && existing.gate_type ? "gate.dissolved" : undefined)),
        event: patch.event,
        updatedAt: t,
      });
      if (patch.assigned !== undefined && patch.assignee_harness === undefined) {
        const harness = patch.harness ?? parsed?.harness ?? "legacy";
        if (patch.assigned == null) {
          db.prepare("UPDATE item_state SET assignee_harness=NULL, assignee_agent=NULL WHERE item_id=?").run(id);
        } else {
          db.prepare("UPDATE item_state SET assignee_harness=?, assignee_agent=? WHERE item_id=?").run(harness, patch.assigned, id);
        }
      }
      return taskApi.get(id);
    },
    delete(id) {
      const r = db.prepare("DELETE FROM items WHERE id=? AND kind='task'").run(id);
      return r.changes > 0;
    },

    openGate({ id, gateType, reason, actor = "system", harness = null, session = null }) {
      const existing = taskApi.get(id);
      if (!existing || (existing.status !== "todo" && existing.status !== "in_progress")) return null;
      const t = now();
      const parsed = splitSessionKey(session);
      db.exec("BEGIN IMMEDIATE");
      try {
        const live = liveAttempt(id);
        const gateRecord = { type: gateType, reason: reason ?? null, actor, openedAt: t };
        if (live) {
          endAttempt(live.id, { status: "gated", endedAt: t, gateRecord });
        } else {
          const s = ensureSession({
            harness: harness ?? parsed?.harness ?? "system",
            agentId: actor,
            externalSessionId: session ?? parsed?.session ?? `gate-${id}`,
            itemId: id,
            kind: "system",
          });
          createAttempt({ itemId: id, sessionId: s.id, status: "gated", claimedAt: t, endedAt: t, leaseSeconds: cfg.leaseSeconds, gateRecord });
        }
        db.prepare(`
          UPDATE item_state SET revision=revision+1, status='blocked', updated_at=? WHERE item_id=?
        `).run(t, id);
        appendEvent({
          itemId: id, fromStatus: existing.status, toStatus: "blocked", kind: "gate.opened",
          actor, note: `gate open: ${gateType}${reason ? ` — ${reason}` : ""}`, at: t,
        });
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return taskApi.get(id);
    },

    resumeGate({ id, actor = "operator", harness = null, session = null }) {
      const existing = taskApi.get(id);
      if (!existing || existing.status !== "blocked") return null;
      const t = now();
      const parsed = splitSessionKey(session);
      let sessionId = null;
      if (harness || parsed) {
        const s = ensureSession({
          harness: harness ?? parsed.harness,
          agentId: actor,
          externalSessionId: session ?? parsed.session,
          itemId: id,
          kind: "system",
        });
        sessionId = s.id;
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`
          UPDATE item_state SET revision=revision+1, status='todo', assignee_harness=NULL, assignee_agent=NULL, updated_at=?
           WHERE item_id=?
        `).run(t, id);
        appendEvent({
          itemId: id, sessionId, fromStatus: "blocked", toStatus: "todo",
          kind: "gate.resolved", actor, note: "gate resume", at: t,
        });
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return taskApi.get(id);
    },

    claim({ id, agentId, harness = null, session = null, sessionKey = null, watchdogMs = null }) {
      const row = itemApi.get(id);
      if (!row || row.kind !== "task") return null;
      const parsed = splitSessionKey(sessionKey);
      const h = harness ?? parsed?.harness ?? "system";
      const extSession = session ?? parsed?.session ?? `store-${agentId}`;
      const t = now();
      const leaseMs = watchdogMs ?? cfg.leaseSeconds * 1000;
      const leaseSeconds = Math.floor(leaseMs / 1000);
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = db.prepare(`
          UPDATE item_state SET status='in_progress', assignee_harness=?, assignee_agent=?, updated_at=?
           WHERE item_id=? AND status='todo' AND deleted_at IS NULL
             AND (assignee_agent IS NULL OR (assignee_agent=? AND (assignee_harness IS NULL OR assignee_harness='legacy' OR assignee_harness=?)))
        `).run(h, agentId, t, id, agentId, h);
        if (r.changes === 0) { db.exec("ROLLBACK"); return null; }
        // A pre-existing assignment may carry a NULL harness (legacy row);
        // the winning claim stamps the pair either way.
        db.prepare("UPDATE item_state SET assignee_harness=?, assignee_agent=? WHERE item_id=?").run(h, agentId, id);
        const sess = ensureSession({ harness: h, agentId, externalSessionId: extSession, itemId: id, kind: "claim" });
        const attempt = createAttempt({ itemId: id, sessionId: sess.id, status: "running", claimedAt: t, leaseSeconds });
        const eventId = appendEvent({
          itemId: id, attemptId: attempt.id, sessionId: sess.id,
          fromStatus: "todo", toStatus: "in_progress", kind: "task.claimed",
          actor: agentId, note: "claim", at: t,
        });
        db.exec("COMMIT");
        const task = taskApi.get(id);
        task.lastEvent = eventById(eventId);
        return task;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    assign({ id, agentId = null, harness = null, actor = "system", capabilities }) {
      const existing = taskApi.get(id);
      if (!existing) throw new Error(`task not found: ${id}`);
      const next = agentId === "" ? null : (agentId ?? null);
      if (existing.status === "in_progress" && (existing.assigned ?? null) !== next) {
        throw new Error(`${existing.id} is in_progress by ${existing.assigned ?? "nobody"}; wait for release before reassigning`);
      }
      const t = now();
      const h = next == null ? null : (harness ?? "legacy");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE item_state SET assignee_harness=?, assignee_agent=?, updated_at=? WHERE item_id=?")
          .run(h, next, t, id);
        if (capabilities !== undefined) {
          db.prepare("DELETE FROM item_tags WHERE item_id=?").run(id);
          for (const tag of capabilities ?? []) {
            db.prepare("INSERT OR IGNORE INTO item_tags(item_id, tag, source, created_at) VALUES (?, ?, ?, ?)")
              .run(id, String(tag), "assign", t);
          }
        }
        appendEvent({
          itemId: id, fromStatus: existing.status, toStatus: existing.status, kind: "task.assigned",
          actor, note: `assign ${next ?? "nobody"}`, at: t,
        });
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return taskApi.get(id);
    },

    heartbeat(id, agentId) {
      const t = now();
      let r = db.prepare(`
        UPDATE attempts SET heartbeat_at=?
         WHERE item_id=? AND ended_at IS NULL
           AND session_id IN (SELECT id FROM work_sessions WHERE agent_id=?)
      `).run(t, id, agentId);
      if (r.changes === 0) {
        // A row can be in_progress without an attempt only when it predates
        // this schema or was seeded directly. Heal it rather than refusing a
        // heartbeat the old store accepted.
        const row = itemApi.get(id);
        if (!row || row.status !== "in_progress" || row.assignee_agent !== agentId) return null;
        const session = ensureSession({
          harness: row.assignee_harness && row.assignee_harness !== "legacy" ? row.assignee_harness : "system",
          agentId, externalSessionId: `heartbeat-${id}`, itemId: id, kind: "system",
        });
        createAttempt({ itemId: id, sessionId: session.id, status: "running", claimedAt: t, leaseSeconds: cfg.leaseSeconds });
        r = db.prepare("UPDATE attempts SET heartbeat_at=? WHERE item_id=? AND ended_at IS NULL").run(t, id);
        if (r.changes === 0) return null;
      }
      db.prepare("UPDATE item_state SET updated_at=? WHERE item_id=?").run(t, id);
      return taskApi.get(id);
    },

    release(id, note = "release", at = now()) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const live = liveAttempt(id);
        if (!live) { db.exec("ROLLBACK"); return null; }
        endAttempt(live.id, { status: "released", endedAt: at });
        db.prepare("UPDATE item_state SET revision=revision+1, status='todo', updated_at=? WHERE item_id=?").run(at, id);
        const eventId = appendEvent({
          itemId: id, attemptId: live.id, sessionId: live.session_id,
          fromStatus: "in_progress", toStatus: "todo", kind: "task.released",
          actor: null, note, at,
        });
        db.exec("COMMIT");
        const task = taskApi.get(id);
        task.lastEvent = eventById(eventId);
        return task;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    sweepExpired({ now: at = Date.now() } = {}) {
      const expired = db.prepare(`
        SELECT a.id, a.item_id, a.attempt_no FROM attempts a
          JOIN item_state s ON s.item_id=a.item_id
         WHERE a.ended_at IS NULL AND s.status='in_progress' AND a.expires_at < ?
      `).all(at);
      const swept = [];
      for (const e of expired) {
        const task = taskApi.release(e.item_id, "sweeper", at);
        if (!task) continue;
        if (e.attempt_no >= cfg.maxAttempts) {
          db.exec("BEGIN IMMEDIATE");
          try {
            const r = db.prepare("UPDATE item_state SET status='blocked', updated_at=? WHERE item_id=? AND status='todo'")
              .run(at, e.item_id);
            if (r.changes > 0) {
              appendEvent({
                itemId: e.item_id, fromStatus: "todo", toStatus: "blocked", kind: "task.blocked",
                actor: "sweeper", note: "blocked: max attempts", at,
              });
            }
            db.exec("COMMIT");
          } catch (err) {
            db.exec("ROLLBACK");
            throw err;
          }
          swept.push(taskApi.get(e.item_id));
        } else {
          swept.push(task);
        }
      }
      return swept;
    },

    recordGateWaits({ now: at = Date.now(), levels = null } = {}) {
      const lv = levels ?? cfg.gateWaitLevels;
      const gates = db.prepare(`
        SELECT s.item_id AS id, a.gate_record_json, a.ended_at
          FROM item_state s
          JOIN attempts a ON a.id = (
            SELECT a2.id FROM attempts a2
             WHERE a2.item_id=s.item_id AND a2.gate_record_json IS NOT NULL
             ORDER BY a2.attempt_no DESC LIMIT 1
          )
         WHERE s.status='blocked' AND s.deleted_at IS NULL
      `).all();
      const written = [];
      for (const g of gates) {
        const gate = jsonIn(g.gate_record_json) ?? {};
        const opened = gate.openedAt ?? g.ended_at;
        if (opened == null) continue;
        const age = at - opened;
        for (const { ms, label } of lv) {
          if (age < ms) continue;
          const note = `gate waiting: ${label} unanswered`;
          const dup = db.prepare("SELECT 1 FROM item_events WHERE item_id=? AND note=? AND created_at>? LIMIT 1")
            .get(g.id, note, opened);
          if (dup) continue;
          const eventId = appendEvent({
            itemId: g.id, fromStatus: "blocked", toStatus: "blocked", kind: "gate.waiting",
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
    addRaw({ fromId, toId, kind = "depends_on" }) {
      db.prepare(`
        INSERT INTO item_edges(from_item_id, to_item_id, kind, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(from_item_id, to_item_id, kind) DO NOTHING
      `).run(fromId, toId, kind, now());
      return depApi.get(fromId, toId);
    },
    get(fromId, toId) {
      const r = db.prepare(`
        SELECT e.from_item_id, e.to_item_id, e.kind, e.created_at,
               fi.kind AS from_kind, ti.kind AS to_kind
          FROM item_edges e
          JOIN items fi ON fi.id=e.from_item_id
          JOIN items ti ON ti.id=e.to_item_id
         WHERE e.from_item_id=? AND e.to_item_id=?
      `).get(fromId, toId);
      if (!r) return null;
      return { from_id: r.from_item_id, from_kind: r.from_kind, to_id: r.to_item_id, to_kind: r.to_kind, created_at: r.created_at, kind: r.kind };
    },
    remove({ fromId, toId }) {
      const r = db.prepare("DELETE FROM item_edges WHERE from_item_id=? AND to_item_id=?").run(fromId, toId);
      return r.changes > 0;
    },
    listOutgoing(fromId) {
      return db.prepare(`
        SELECT e.from_item_id, e.to_item_id, e.kind, e.created_at,
               fi.kind AS from_kind, ti.kind AS to_kind
          FROM item_edges e
          JOIN items fi ON fi.id=e.from_item_id
          JOIN items ti ON ti.id=e.to_item_id
         WHERE e.from_item_id=?
      `).all(fromId).map((r) => ({ from_id: r.from_item_id, from_kind: r.from_kind, to_id: r.to_item_id, to_kind: r.to_kind, created_at: r.created_at, kind: r.kind }));
    },
    listIncoming(toId) {
      return db.prepare(`
        SELECT e.from_item_id, e.to_item_id, e.kind, e.created_at,
               fi.kind AS from_kind, ti.kind AS to_kind
          FROM item_edges e
          JOIN items fi ON fi.id=e.from_item_id
          JOIN items ti ON ti.id=e.to_item_id
         WHERE e.to_item_id=?
      `).all(toId).map((r) => ({ from_id: r.from_item_id, from_kind: r.from_kind, to_id: r.to_item_id, to_kind: r.to_kind, created_at: r.created_at, kind: r.kind }));
    },
    all() {
      return db.prepare("SELECT * FROM item_edges").all();
    },
  };

  // ──────────────────────────────────────────────────── HARNESS WEBHOOKS
  const webhookApi = {
    upsert({ harness, url, bearer = null, timeoutMs = null }) {
      const h = typeof harness === "string" ? harness.trim() : "";
      if (!h) throw new Error("webhook target requires a harness");
      let u;
      try { u = new URL(url); } catch { throw new Error(`invalid webhook url: ${JSON.stringify(url)}`); }
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error(`webhook url must be http(s): ${JSON.stringify(url)}`);
      }
      if (timeoutMs != null && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
        throw new Error(`webhook timeoutMs must be a positive integer, got ${JSON.stringify(timeoutMs)}`);
      }
      const t = now();
      db.prepare(`
        INSERT INTO harness_webhooks(harness, url, bearer, timeout_ms, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(harness) DO UPDATE SET url=excluded.url, bearer=excluded.bearer,
          timeout_ms=excluded.timeout_ms, updated_at=excluded.updated_at
      `).run(h, u.toString(), bearer ?? null, timeoutMs ?? null, t, t);
      return webhookApi.get(h);
    },
    remove({ harness }) {
      const r = db.prepare("DELETE FROM harness_webhooks WHERE harness=?").run(harness);
      return r.changes > 0;
    },
    list() {
      return db.prepare("SELECT * FROM harness_webhooks ORDER BY harness ASC").all();
    },
    get(harness) {
      const r = db.prepare("SELECT * FROM harness_webhooks WHERE harness=?").get(harness);
      if (!r) return null;
      return { harness: r.harness, url: r.url, bearer: r.bearer, timeoutMs: r.timeout_ms };
    },
  };

  // ─────────────────────────────────────────────────────── EVENT READ API
  const eventApi = {
    append: appendEvent,
    get: eventById,
    listFor: eventsFor,
    lastEventId() {
      return db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM item_events").get().m;
    },
    since(id, limit = 200) {
      return db.prepare("SELECT * FROM item_events WHERE id > ? ORDER BY id LIMIT ?").all(id, limit);
    },
    latest(limit = 200) {
      return db.prepare("SELECT * FROM item_events ORDER BY id DESC LIMIT ?").all(limit).reverse();
    },
  };

  function itemKindOf(id) {
    return itemApi.kindOf(id);
  }

  return {
    db,
    orm,
    path: finalPath,
    config: cfg,
    item: itemApi,
    state: {
      get(itemId) {
        const r = db.prepare("SELECT * FROM item_state WHERE item_id=?").get(itemId);
        return r ? { ...r, state_json: jsonIn(r.state_json) ?? {} } : null;
      },
    },
    attempt: attemptApi,
    session: {
      ensure: ensureSession,
      get(id) { return db.prepare("SELECT * FROM work_sessions WHERE id=?").get(id) ?? null; },
      forItem(itemId) { return db.prepare("SELECT * FROM work_sessions WHERE item_id=? ORDER BY created_at DESC").all(itemId); },
    },
    artifact: artifactApi,
    event: eventApi,
    epic: epicApi,
    story: storyApi,
    task: taskApi,
    dep: depApi,
    webhook: webhookApi,
    itemKindOf,
    close() { db.close(); },
  };
}
