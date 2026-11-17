// Durable wake admission. Core owns the queue; a harness only accepts an
// offer, and an item in_progress is the slot that work is actually running.
import { newAdmissionId } from "../ids.js";
import { HUMAN_HARNESS } from "../reserved.js";

const LIVE = "ended_at IS NULL";
export function createAdmissionApi({ core }) {
  const { db, now } = core;

  function rowById(id) {
    return db.prepare("SELECT * FROM admission_queue WHERE id=?").get(id) ?? null;
  }

  function live(itemId, harness) {
    return db.prepare(`SELECT * FROM admission_queue WHERE item_id=? AND harness=? AND ${LIVE}`)
      .get(itemId, harness) ?? null;
  }

  function enqueue({ kind, itemId, harness, agentId, eventId = null, at = now() }) {
    if (!itemId || !harness || !agentId) return null;
    if (eventId != null) {
      const seen = db.prepare(`
        SELECT * FROM admission_queue
         WHERE event_id=? AND kind=? AND item_id=? AND agent_id=? LIMIT 1
      `).get(eventId, kind, itemId, agentId);
      if (seen) return seen;
    }
    const existing = live(itemId, harness);
    if (existing) {
      if (existing.status === "active") return existing;
      if (existing.event_id === eventId && existing.agent_id === agentId && existing.kind === kind) {
        return existing;
      }
      const reset = existing.status === "offered" || existing.status === "accepted" || existing.status === "expired";
      db.prepare(`
        UPDATE admission_queue
           SET kind=?, agent_id=?, event_id=?, status=?, executor_id=NULL,
               offered_at=NULL, accepted_at=NULL, backoff_until=0
         WHERE id=?
      `).run(kind, agentId, eventId, reset ? "queued" : existing.status, existing.id);
      return rowById(existing.id);
    }
    const id = newAdmissionId();
    db.prepare(`
      INSERT INTO admission_queue(id, kind, item_id, harness, agent_id, status, event_id, created_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(id, kind, itemId, harness, agentId, eventId, at);
    return rowById(id);
  }

  function queued(harness, at = now(), limit = null) {
    const sql = `SELECT * FROM admission_queue
                  WHERE status='queued' AND ended_at IS NULL AND backoff_until<=?
                    AND (harness=? OR harness='*')
                  ORDER BY created_at ASC, id ASC${limit ? " LIMIT ?" : ""}`;
    return limit ? db.prepare(sql).all(at, harness, limit) : db.prepare(sql).all(at, harness);
  }

  function offers(harness) {
    return db.prepare(`SELECT * FROM admission_queue
                        WHERE status='offered' AND ended_at IS NULL
                          AND (harness=? OR harness='*')
                        ORDER BY offered_at ASC, created_at ASC`).all(harness);
  }

  function markOffered(id, at = now()) {
    const r = db.prepare(`
      UPDATE admission_queue
         SET status='offered', offered_at=?, accepted_at=NULL, executor_id=NULL, offers=offers+1
       WHERE id=? AND status='queued' AND ended_at IS NULL
    `).run(at, id);
    return r.changes > 0 ? rowById(id) : null;
  }

  function accept(id, { executorId, harness, at = now(), harnessMax = null }) {
    const current = rowById(id);
    if (current && current.status === "accepted" && current.executor_id === executorId) {
      return { granted: true, row: current, duplicate: true };
    }
    // A broadcast row is not reserved against any one harness until accept;
    // refuse here rather than let the winner push its harness over its cap.
    if (harnessMax && current?.harness === "*" && slotCount(harness) >= harnessMax) {
      return { granted: false, row: current, reason: "harness_full" };
    }
    const r = db.prepare(`
      UPDATE admission_queue
         SET status='accepted', executor_id=?, accepted_at=?,
             harness=CASE WHEN harness='*' THEN ? ELSE harness END
       WHERE id=? AND status='offered' AND ended_at IS NULL
         AND (harness=? OR harness='*')
    `).run(executorId, at, harness, id, harness);
    if (r.changes > 0) return { granted: true, row: rowById(id) };
    const row = rowById(id);
    if (row && row.status === "accepted" && row.executor_id === executorId) {
      return { granted: true, row, duplicate: true };
    }
    return { granted: false, row };
  }

  function activate(itemId, harness, at = now()) {
    db.prepare(`
      UPDATE admission_queue
         SET status='active', admitted_at=?, offered_at=COALESCE(offered_at, ?), accepted_at=COALESCE(accepted_at, ?)
       WHERE item_id=? AND ended_at IS NULL AND status IN ('queued','offered','accepted')
         AND (harness=? OR harness='*')
    `).run(at, at, at, itemId, harness);
  }

  function release(itemId, status, at = now(), exceptEventId = null) {
    const terminal = status === "done" || status === "cancelled";
    const skip = exceptEventId != null ? " AND (event_id IS NULL OR event_id != ?)" : "";
    const sql = `UPDATE admission_queue SET status=?, ended_at=? WHERE item_id=? AND ended_at IS NULL${skip}`;
    const args = [terminal ? status : "done", at, itemId];
    if (exceptEventId != null) args.push(exceptEventId);
    db.prepare(sql).run(...args);
  }

  function expire({ at = now(), offerMs, baseBackoffMs, maxBackoffMs, maxAttempts }) {
    const rows = db.prepare(`
      SELECT * FROM admission_queue
       WHERE status IN ('offered','accepted') AND ended_at IS NULL
         AND COALESCE(accepted_at, offered_at, created_at) + ? < ?
    `).all(offerMs, at);
    for (const row of rows) {
      // Append and review wakes have no claim to confirm; once accepted they
      // are one-shot, so TTL ends them instead of re-waking the planner.
      if (row.status === "accepted" && (row.kind === "append" || row.kind === "review")) {
        db.prepare("UPDATE admission_queue SET status='done', admitted_at=?, ended_at=? WHERE id=?")
          .run(at, at, row.id);
        continue;
      }
      if (row.offers >= maxAttempts) {
        db.prepare("UPDATE admission_queue SET status='expired', executor_id=NULL, ended_at=? WHERE id=?")
          .run(at, row.id);
        continue;
      }
      const backoff = Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.max(0, row.offers - 1));
      db.prepare(`
        UPDATE admission_queue SET status='expired', executor_id=NULL,
               accepted_at=NULL, backoff_until=?
         WHERE id=?
      `).run(at + backoff, row.id);
    }
    db.prepare("UPDATE admission_queue SET status='queued' WHERE status='expired' AND ended_at IS NULL AND backoff_until<=?")
      .run(at);
  }

  function requeueExecutor(executorId, at = now()) {
    db.prepare(`
      UPDATE admission_queue
         SET status='queued', executor_id=NULL, accepted_at=NULL, offered_at=NULL, backoff_until=0
       WHERE executor_id=? AND status IN ('offered','accepted') AND ended_at IS NULL
    `).run(executorId);
  }

  function resetOffers(at = now()) {
    db.prepare(`
      UPDATE admission_queue
         SET status='queued', executor_id=NULL, accepted_at=NULL, offered_at=NULL, backoff_until=0
       WHERE status IN ('offered','accepted') AND ended_at IS NULL
    `).run();
  }

  function lastEventId() {
    return db.prepare("SELECT COALESCE(MAX(event_id), 0) AS id FROM admission_queue").get().id;
  }

  function setParentCursor(itemId, at = now()) {
    const child = db.prepare("SELECT parent_id, child_key FROM items WHERE id=?").get(itemId);
    if (!child?.child_key || !child.parent_id) return;
    db.prepare(`
      UPDATE item_state SET state_json=json_set(state_json, '$.currentChildKey', ?), updated_at=?
       WHERE item_id=? AND deleted_at IS NULL
    `).run(child.child_key, at, child.parent_id);
  }

  function slots() {
    const active = new Map();
    for (const r of db.prepare(`
      SELECT assignee_harness AS harness, COUNT(*) AS n
        FROM item_state
       WHERE status='in_progress' AND deleted_at IS NULL AND assignee_harness IS NOT NULL
         AND assignee_harness != ?
       GROUP BY assignee_harness
    `).all(HUMAN_HARNESS)) active.set(r.harness, r.n);
    const reserved = new Map();
    for (const r of db.prepare(`
      SELECT harness, COUNT(*) AS n
        FROM admission_queue
       WHERE status IN ('offered','accepted') AND ended_at IS NULL
       GROUP BY harness
    `).all()) reserved.set(r.harness, r.n);
    return { active, reserved };
  }

  function slotCount(harness) {
    const { active, reserved } = slots();
    return (active.get(harness) ?? 0) + (reserved.get(harness) ?? 0);
  }

  function globalSlotCount() {
    const { active, reserved } = slots();
    let n = 0;
    for (const v of active.values()) n += v;
    for (const v of reserved.values()) n += v;
    return n;
  }

  return {
    enqueue,
    live,
    get: rowById,
    queued,
    offers,
    markOffered,
    accept,
    activate,
    release,
    expire,
    requeueExecutor,
    resetOffers,
    lastEventId,
    setParentCursor,
    slots,
    slotCount,
    globalSlotCount,
  };
}
