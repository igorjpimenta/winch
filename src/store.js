// store.js — unified item data layer over better-sqlite3 + Drizzle.
//
// Epics, stories and tasks collapsed into one `items` table (kind discriminator
// + parent_id). The legacy `epic`/`story`/`task` namespaces remain as thin
// wrappers so callers and tests keep working; new code should prefer `item`.

import { newEpicId, newStoryId, newTaskId, classifyId } from "./ids.js";
import { resolveConfig } from "./config.js";
import { resolveDbPath } from "./paths.js";
import { openDatabase } from "./db.js";
import { ITEM_STATUSES, EXECUTION_KINDS, ITEM_KINDS } from "./schema.js";

export { ITEM_STATUSES as EPIC_STATUSES, ITEM_STATUSES as STORY_STATUSES, ITEM_STATUSES as TASK_STATUSES, EXECUTION_KINDS, ITEM_KINDS };
export const MAX_ATTEMPTS = 3;

const TERMINAL = new Set(["done", "cancelled"]);

function now() { return Date.now(); }
function jsonOut(v) { return v == null ? null : JSON.stringify(v); }
function jsonIn(v)  { if (v == null) return null; try { return JSON.parse(v); } catch { return null; } }

function rowItem(r) {
  if (!r) return null;
  return {
    ...r,
    parent_id: r.parent_id ?? null,
    capabilities: jsonIn(r.capabilities),
    execution_args: jsonIn(r.execution_args) ?? {},
  };
}

function defaultStatusFor(kind) {
  if (kind === "epic") return "idea";
  if (kind === "story") return "backlog";
  return "todo";
}

export function createStore({ dbPath, logger, config: explicitConfig } = {}) {
  const finalPath = dbPath || resolveDbPath();
  const { sqlite: db, orm } = openDatabase({ dbPath: finalPath, logger });
  const cfg = resolveConfig({ explicit: explicitConfig ?? {} });

  const ITEM_KIND_SET = new Set(ITEM_KINDS);
  const STATUS_SET = new Set(ITEM_STATUSES);
  const EXEC_SET = new Set(EXECUTION_KINDS);

  function insertEvent({ itemId, itemKind = "task", fromStatus, toStatus, kind = null, actor, note, at, sessionRef }) {
    const r = db.prepare(`
      INSERT INTO events(item_id, item_kind, from_status, to_status, kind, actor, note, session_ref, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(itemId, itemKind, fromStatus ?? null, toStatus, kind, actor ?? null, note ?? null, sessionRef ?? null, at);
    return Number(r.lastInsertRowid);
  }

  const itemApi = {
    create({ kind, parentId, title, description, acceptance, status, size, priority, assigned, capabilities, executionKind, executionArgs, ownerTeam, createdBy, id }) {
      if (!ITEM_KIND_SET.has(kind)) throw new Error(`invalid item kind: ${kind}`);
      const itemId = id || (kind === "epic" ? newEpicId() : kind === "story" ? newStoryId() : newTaskId());
      const t = now();
      const s = status || defaultStatusFor(kind);
      if (!STATUS_SET.has(s)) throw new Error(`invalid item status: ${s}`);
      const ek = executionKind || (kind === "task" ? "manual" : "manual");
      if (kind === "task" && !EXEC_SET.has(ek)) throw new Error(`invalid execution_kind: ${ek}`);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`
          INSERT INTO items(id, parent_id, kind, title, description, acceptance, status, size, priority, owner_team, created_by, assigned, capabilities, execution_kind, execution_args, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(itemId, parentId ?? null, kind, title, description ?? null, acceptance ?? null, s, size ?? null, priority ?? 50, ownerTeam ?? null, createdBy ?? null, assigned ?? null, jsonOut(capabilities), (kind === "task" ? ek : (executionKind ?? "manual")), JSON.stringify(executionArgs ?? {}), t, t);
        if (kind === "task") {
          insertEvent({ itemId, itemKind: kind, fromStatus: null, toStatus: s, kind: "task.created", actor: null, note: "task created", at: t });
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return itemApi.get(itemId);
    },
    get(id) {
      return rowItem(db.prepare("SELECT * FROM items WHERE id=?").get(id));
    },
    list({ parentId, kind, status, assigned } = {}) {
      const where = [];
      const args = [];
      if (parentId) { where.push("parent_id=?"); args.push(parentId); }
      if (kind)     { where.push("kind=?");      args.push(kind); }
      if (status)   { where.push("status=?");    args.push(status); }
      if (assigned) { where.push("assigned=?");  args.push(assigned); }
      const sql = `SELECT * FROM items${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY priority DESC, created_at ASC`;
      return db.prepare(sql).all(...args).map(rowItem);
    },
    update(id, patch) {
      const existing = itemApi.get(id);
      if (!existing) throw new Error(`item not found: ${id}`);
      if (patch.status && !STATUS_SET.has(patch.status)) throw new Error(`invalid item status: ${patch.status}`);
      const merged = {
        ...existing,
        ...patch,
        capabilities: patch.capabilities !== undefined ? patch.capabilities : existing.capabilities,
        execution_args: patch.execution_args !== undefined ? patch.execution_args : existing.execution_args,
        updated_at: now(),
      };
      if (patch.status && TERMINAL.has(patch.status) && !existing.closed_at) merged.closed_at = merged.updated_at;
      // gate metadata handling for blocked transitions
      if (merged.status === "blocked" && existing.status !== "blocked") {
        merged.gate_type = patch.gateType !== undefined ? patch.gateType : existing.gate_type;
        merged.blocked_at = now();
      } else if (existing.status === "blocked" && merged.status !== "blocked") {
        merged.gate_type = null;
        merged.blocked_at = null;
      } else {
        merged.gate_type = patch.gateType !== undefined ? patch.gateType : existing.gate_type;
      }
      const statusChanged = patch.status != null && patch.status !== existing.status;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`
          UPDATE items SET parent_id=?, kind=?, title=?, description=?, acceptance=?, status=?, size=?, priority=?, owner_team=?, created_by=?, assigned=?, capabilities=?, execution_kind=?, execution_args=?, claim_expires_at=?, lease_seconds=?, last_heartbeat=?, attempt_count=?, gate_type=?, blocked_at=?, result_summary=?, updated_at=?, claimed_at=?, closed_at=?, deleted_at=?
          WHERE id=?
        `).run(
          merged.parent_id, merged.kind, merged.title, merged.description, merged.acceptance, merged.status, merged.size, merged.priority, merged.owner_team, merged.created_by, merged.assigned,
          jsonOut(merged.capabilities), merged.execution_kind, JSON.stringify(merged.execution_args ?? {}), merged.claim_expires_at,
          merged.lease_seconds, merged.last_heartbeat, merged.attempt_count, merged.gate_type, merged.blocked_at,
          merged.result_summary, merged.updated_at, merged.claimed_at, merged.closed_at, merged.deleted_at ?? null,
          id
        );
        if (merged.kind === "task" && statusChanged) {
          insertEvent({
            itemId: id, itemKind: merged.kind, fromStatus: existing.status, toStatus: merged.status,
            kind: kindForUpdate(existing, merged), actor: patch.actor ?? "system", note: patch.note ?? null, at: merged.updated_at,
            sessionRef: patch.sessionKey ?? null,
          });
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return itemApi.get(id);
    },
    delete(id) {
      const r = db.prepare("DELETE FROM items WHERE id=?").run(id);
      return r.changes > 0;
    },
    claim({ id, agentId, watchdogMs = null, sessionKey }) {
      const t = now();
      const leaseMs = watchdogMs ?? cfg.leaseSeconds * 1000;
      const expires = t + leaseMs;
      const leaseSeconds = Math.floor(leaseMs / 1000);
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = db.prepare(`
          UPDATE items SET status='in_progress', assigned=?, claimed_at=?, claim_expires_at=?, lease_seconds=?, last_heartbeat=?, updated_at=?
          WHERE id=? AND status='todo' AND (assigned IS NULL OR assigned=?)
        `).run(agentId, t, expires, leaseSeconds, t, t, id, agentId);
        if (r.changes === 0) { db.exec("ROLLBACK"); return null; }
        const cur = db.prepare("SELECT kind FROM items WHERE id=?").get(id);
        const eventsId = insertEvent({
          itemId: id, itemKind: cur?.kind ?? "task", fromStatus: "todo", toStatus: "in_progress", kind: "task.claimed",
          actor: agentId, note: "claim", at: t, sessionRef: sessionKey ?? null,
        });
        db.exec("COMMIT");
        const item = itemApi.get(id);
        item.lastEvent = rowEvent(db.prepare("SELECT * FROM events WHERE id=?").get(eventsId));
        return item;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    assign({ id, agentId = null, actor = "system", capabilities }) {
      const existing = itemApi.get(id);
      if (!existing) throw new Error(`item not found: ${id}`);
      const next = agentId === "" ? null : (agentId ?? null);
      if (existing.status === "in_progress" && (existing.assigned ?? null) !== next) {
        throw new Error(`${existing.id} is in_progress by ${existing.assigned ?? "nobody"}; wait for release before reassigning`);
      }
      const t = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE items SET assigned=?, capabilities=?, updated_at=? WHERE id=?")
          .run(next, jsonOut(capabilities !== undefined ? capabilities : existing.capabilities), t, id);
        insertEvent({ itemId: id, itemKind: existing.kind, fromStatus: existing.status, toStatus: existing.status, kind: "task.assigned", actor, note: `assign ${next ?? "nobody"}`, at: t });
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return itemApi.get(id);
    },
    heartbeat(id, agentId) {
      const t = now();
      const r = db.prepare(`
        UPDATE items SET last_heartbeat=?, updated_at=?, claim_expires_at=?+COALESCE(lease_seconds*1000, ?) WHERE id=? AND status='in_progress' AND assigned=?
      `).run(t, t, t, cfg.leaseSeconds * 1000, id, agentId);
      if (r.changes === 0) return null;
      return itemApi.get(id);
    },
    release(id, note = "release", at = now()) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = db.prepare(`
          UPDATE items SET status='todo', claimed_at=NULL, claim_expires_at=NULL, attempt_count=attempt_count+1, updated_at=?
          WHERE id=? AND status='in_progress'
        `).run(at, id);
        if (r.changes === 0) { db.exec("ROLLBACK"); return null; }
        const cur = db.prepare("SELECT kind FROM items WHERE id=?").get(id);
        const eventsId = insertEvent({ itemId: id, itemKind: cur?.kind ?? "task", fromStatus: "in_progress", toStatus: "todo", kind: "task.released", actor: null, note, at });
        db.exec("COMMIT");
        const item = itemApi.get(id);
        item.lastEvent = rowEvent(db.prepare("SELECT * FROM events WHERE id=?").get(eventsId));
        return item;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    sweepExpired({ now: at = Date.now() } = {}) {
      const expired = db.prepare("SELECT id FROM items WHERE status='in_progress' AND claim_expires_at < ?").all(at);
      const swept = [];
      for (const { id } of expired) {
        const item = itemApi.release(id, "sweeper", at);
        if (!item) continue;
        if (item.attempt_count >= cfg.maxAttempts) {
          db.exec("BEGIN IMMEDIATE");
          try {
            const r = db.prepare("UPDATE items SET status='blocked', updated_at=? WHERE id=? AND status='todo'").run(at, id);
            if (r.changes > 0) {
              const cur = db.prepare("SELECT kind FROM items WHERE id=?").get(id);
              insertEvent({ itemId: id, itemKind: cur?.kind ?? "task", fromStatus: "todo", toStatus: "blocked", kind: "task.blocked", actor: "sweeper", note: "blocked: max attempts", at });
            }
            db.exec("COMMIT");
          } catch (err) {
            db.exec("ROLLBACK");
            throw err;
          }
          swept.push(itemApi.get(id));
        } else {
          swept.push(item);
        }
      }
      return swept;
    },
    openGate({ id, gateType, reason, actor = "system" }) {
      const t = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const cur = db.prepare("SELECT status, kind FROM items WHERE id=?").get(id);
        if (!cur || (cur.status !== "todo" && cur.status !== "in_progress")) {
          db.exec("ROLLBACK");
          return null;
        }
        db.prepare("UPDATE items SET status='blocked', gate_type=?, blocked_at=?, updated_at=? WHERE id=? AND status IN ('todo','in_progress')")
          .run(gateType, t, t, id);
        insertEvent({ itemId: id, itemKind: cur.kind, fromStatus: cur.status, toStatus: "blocked", kind: "gate.opened", actor, note: `gate open: ${gateType}${reason ? ` — ${reason}` : ""}`, at: t });
        db.exec("COMMIT");
        return itemApi.get(id);
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    resumeGate({ id, actor = "operator" }) {
      const t = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const cur = db.prepare("SELECT status, kind FROM items WHERE id=?").get(id);
        if (!cur || cur.status !== "blocked") {
          db.exec("ROLLBACK");
          return null;
        }
        db.prepare("UPDATE items SET status='todo', assigned=NULL, claimed_at=NULL, claim_expires_at=NULL, gate_type=NULL, blocked_at=NULL, updated_at=? WHERE id=? AND status='blocked'")
          .run(t, id);
        insertEvent({ itemId: id, itemKind: cur.kind, fromStatus: "blocked", toStatus: "todo", kind: "gate.resolved", actor, note: "gate resume", at: t });
        db.exec("COMMIT");
        return itemApi.get(id);
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    recordGateWaits({ now: at = Date.now(), levels = null } = {}) {
      const lv = levels ?? cfg.gateWaitLevels;
      const gates = db.prepare("SELECT id, blocked_at, kind FROM items WHERE status='blocked' AND gate_type IS NOT NULL AND blocked_at IS NOT NULL").all();
      const written = [];
      for (const g of gates) {
        const age = at - g.blocked_at;
        for (const { ms, label } of lv) {
          if (age < ms) continue;
          const note = `gate waiting: ${label} unanswered`;
          const dup = db.prepare("SELECT 1 FROM events WHERE item_id=? AND note=? AND at>? LIMIT 1").get(g.id, note, g.blocked_at);
          if (dup) continue;
          const eventId = insertEvent({ itemId: g.id, itemKind: g.kind, fromStatus: "blocked", toStatus: "blocked", kind: "gate.waiting", actor: "watcher", note, at });
          written.push({ taskId: g.id, label, eventId });
        }
      }
      return written;
    },
  };

  function rowEvent(r) { return r ? { ...r } : null; }
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

  // Patch kindForUpdate reference inside update (it was called before def). Move definition above? It's hoisted function declaration.
  // Actually kindForUpdate defined below update call site but function declaration hoisted. OK.

  const depApi = {
    addRaw({ fromId, fromKind, toId, toKind }) {
      db.prepare(`
        INSERT INTO deps(from_item_id, from_kind, to_item_id, to_kind, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(from_item_id, to_item_id) DO NOTHING
      `).run(fromId, fromKind, toId, toKind, now());
      return db.prepare("SELECT * FROM deps WHERE from_item_id=? AND to_item_id=?").get(fromId, toId);
    },
    remove({ fromId, toId }) {
      const r = db.prepare("DELETE FROM deps WHERE from_item_id=? AND to_item_id=?").run(fromId, toId);
      return r.changes > 0;
    },
    listOutgoing(fromId) {
      return db.prepare("SELECT * FROM deps WHERE from_item_id=?").all(fromId);
    },
    listIncoming(toId) {
      return db.prepare("SELECT * FROM deps WHERE to_item_id=?").all(toId);
    },
    all() {
      return db.prepare("SELECT * FROM deps").all();
    },
  };

  const webhookApi = {
    upsert({ harness, url, bearer = null, timeoutMs = null }) {
      const h = typeof harness === "string" ? harness.trim() : "";
      if (!h) throw new Error("webhook target requires a harness");
      let u;
      try { u = new URL(url); } catch { throw new Error(`invalid webhook url: ${JSON.stringify(url)}`); }
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`webhook url must be http(s): ${JSON.stringify(url)}`);
      if (timeoutMs != null && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) throw new Error(`webhook timeoutMs must be a positive integer, got ${JSON.stringify(timeoutMs)}`);
      const t = now();
      db.prepare(`
        INSERT INTO webhook_targets(harness, url, bearer, timeout_ms, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(harness) DO UPDATE SET url=excluded.url, bearer=excluded.bearer, timeout_ms=excluded.timeout_ms, updated_at=excluded.updated_at
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

  const usageApi = {
    record({ harness, agent, session, itemId = null, itemKind = null, usage, source = "meta", at = now() }) {
      if (!usage) return null;
      const u = usage;
      const r = db.prepare(`
        INSERT INTO usage_events(harness, agent, session, item_id, item_kind, model, tokens_in, tokens_out, cache_read, cost_usd, tool_calls, source, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(harness, agent, session, itemId, itemKind, u.model ?? null, u.tokensIn ?? null, u.tokensOut ?? null, u.cacheRead ?? null, u.costUsd ?? null, u.toolCalls ?? null, source ?? null, at);
      return Number(r.lastInsertRowid);
    },
    list({ harness, agent, session, itemId, itemKind, since, limit } = {}) {
      const where = [];
      const args = [];
      if (harness) { where.push("harness=?"); args.push(harness); }
      if (agent)   { where.push("agent=?");   args.push(agent); }
      if (session) { where.push("session=?"); args.push(session); }
      if (itemId)  { where.push("item_id=?"); args.push(itemId); }
      if (itemKind){ where.push("item_kind=?"); args.push(itemKind); }
      if (since)   { where.push("at>=?");     args.push(since); }
      const lim = Number.isInteger(limit) && limit > 0 ? limit : 100;
      const sql = `SELECT * FROM usage_events${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC LIMIT ?`;
      args.push(lim);
      return db.prepare(sql).all(...args);
    },
    summary({ harness, agent, session, itemId, itemKind, since } = {}) {
      const where = [];
      const args = [];
      if (harness) { where.push("harness=?"); args.push(harness); }
      if (agent)   { where.push("agent=?");   args.push(agent); }
      if (session) { where.push("session=?"); args.push(session); }
      if (itemId)  { where.push("item_id=?"); args.push(itemId); }
      if (itemKind){ where.push("item_kind=?"); args.push(itemKind); }
      if (since)   { where.push("at>=?");     args.push(since); }
      const sql = `SELECT COUNT(*) AS calls, COALESCE(SUM(tokens_in),0) AS tokens_in, COALESCE(SUM(tokens_out),0) AS tokens_out, COALESCE(SUM(cache_read),0) AS cache_read, COALESCE(SUM(cost_usd),0) AS cost_usd, COALESCE(SUM(tool_calls),0) AS tool_calls FROM usage_events${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
      return db.prepare(sql).get(...args);
    },
  };

  const sessionApi = {
    bind(sessionKey, itemId, itemKind) {
      if (!sessionKey || !itemId) return null;
      db.prepare(`
        INSERT INTO session_bindings(session_key, item_id, item_kind, bound_at, released_at)
        VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT(session_key) DO UPDATE SET
          item_id=excluded.item_id, item_kind=excluded.item_kind,
          bound_at=excluded.bound_at, released_at=NULL
      `).run(sessionKey, itemId, itemKind ?? null, now());
      return true;
    },
    get(sessionKey) {
      const r = db.prepare("SELECT item_id, item_kind FROM session_bindings WHERE session_key=? AND released_at IS NULL").get(sessionKey);
      return r ? { itemId: r.item_id, itemKind: r.item_kind } : null;
    },
    release(sessionKey) {
      db.prepare("UPDATE session_bindings SET released_at=? WHERE session_key=? AND released_at IS NULL").run(now(), sessionKey);
    },
  };

  function itemKindOf(id) {
    const cls = classifyId(id);
    if (!cls) return null;
    const row = db.prepare("SELECT id FROM items WHERE id=?").get(id);
    return row ? cls : null;
  }

  // Convenience wrappers preserving legacy epic/story/task namespaces.
  function wrap(kindFilter) {
    return {
      create(args) {
        const a = { ...(args || {}) };
        const parentId = a.parentId ?? a.epicId ?? a.storyId ?? a.epic_id ?? a.story_id ?? null;
        delete a.epicId; delete a.storyId; delete a.epic_id; delete a.story_id;
        return itemApi.create({ ...a, parentId, kind: kindFilter });
      },
      get(id) {
        const it = itemApi.get(id);
        return it && it.kind === kindFilter ? it : null;
      },
      list(opts = {}) {
        const o = { ...(opts || {}) };
        const parentId = o.parentId ?? o.epicId ?? o.storyId ?? o.epic_id ?? o.story_id;
        delete o.epicId; delete o.storyId; delete o.epic_id; delete o.story_id;
        if (parentId !== undefined) o.parentId = parentId;
        return itemApi.list({ ...o, kind: kindFilter });
      },
      update(id, patch) {
        const it = itemApi.get(id);
        if (!it || it.kind !== kindFilter) throw new Error(`${kindFilter} not found: ${id}`);
        return itemApi.update(id, patch);
      },
      delete(id) {
        const it = itemApi.get(id);
        if (!it || it.kind !== kindFilter) return false;
        return itemApi.delete(id);
      },
    };
  }

  const epicApi = wrap("epic");
  const storyApi = wrap("story");
  const taskApi = {
    ...wrap("task"),
    claim: itemApi.claim,
    assign: itemApi.assign,
    heartbeat: itemApi.heartbeat,
    release: itemApi.release,
    openGate: itemApi.openGate,
    resumeGate: itemApi.resumeGate,
    sweepExpired: itemApi.sweepExpired,
    recordGateWaits: itemApi.recordGateWaits,
  };

  // Back-compat field aliases on returned rows: tests read epic_id/story_id/task_id? 
  // We add parent_id; keep story_id/epic_id aliases via row mapping? Instead, augment get in wrappers.
  const origGet = itemApi.get;
  itemApi.get = (id) => {
    const r = origGet(id);
    if (!r) return null;
    if (r.kind === "story") r.epic_id = r.parent_id;
    if (r.kind === "task") r.story_id = r.parent_id;
    return r;
  };
  // apply alias in list too
  const origList = itemApi.list;
  itemApi.list = (opts) => origList(opts).map((r) => {
    if (r.kind === "story") r.epic_id = r.parent_id;
    if (r.kind === "task") r.story_id = r.parent_id;
    return r;
  });

  return {
    db, orm, path: finalPath, config: cfg,
    item: itemApi,
    epic: epicApi,
    story: storyApi,
    task: taskApi,
    dep: depApi,
    webhook: webhookApi,
    usage: usageApi,
    session: sessionApi,
    itemKindOf,
    close() { db.close(); },
  };
}

function rowEvent(r) { return r ? { ...r } : null; }