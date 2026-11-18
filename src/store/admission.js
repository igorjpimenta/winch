// Durable wake admission. The queue is the identity and route; delivery
// attempts live in admission_attempts so offer/accept/retry history has one
// grain. Offer TTL, backoff, and executor ownership are attempt facts.
import { newAdmissionId } from "../ids.js";
import { HUMAN_HARNESS } from "../reserved.js";

const LIVE = "ended_at IS NULL";

export function createAdmissionApi({ core }) {
  const { db, now } = core;

  function liveAttempt(admissionId) {
    return db.prepare(`
      SELECT * FROM admission_attempts
       WHERE admission_id=? AND ended_at IS NULL
       ORDER BY attempt_no DESC LIMIT 1
    `).get(admissionId) ?? null;
  }

  function attemptCount(admissionId) {
    return db.prepare("SELECT COUNT(*) AS n FROM admission_attempts WHERE admission_id=?").get(admissionId).n;
  }

  function rowById(id) {
    const row = db.prepare("SELECT * FROM admission_queue WHERE id=?").get(id);
    if (!row) return null;
    const attempt = liveAttempt(id);
    return {
      ...row,
      offers: attemptCount(id),
      attempt_no: attempt?.attempt_no ?? null,
      executor_id: attempt?.executor_id ?? null,
      offered_at: attempt?.offered_at ?? null,
      accepted_at: attempt?.accepted_at ?? null,
    };
  }

  function endAttempts(ids, at) {
    if (!ids.length) return;
    const marks = ids.map(() => "?").join(",");
    db.prepare(`UPDATE admission_attempts SET ended_at=? WHERE admission_id IN (${marks}) AND ended_at IS NULL`)
      .run(at, ...ids);
  }

  function live(itemId, harness) {
    return db.prepare(`SELECT * FROM admission_queue WHERE item_id=? AND harness=? AND ${LIVE}`)
      .get(itemId, harness) ?? null;
  }

  function enqueue({ kind, itemId, harness, agentId, eventId = null, at = now() }) {
    if (!itemId || !harness || !agentId) return null;
    if (eventId != null) {
      const seen = db.prepare(`
        SELECT id FROM admission_queue
         WHERE event_id=? AND kind=? AND item_id=? AND agent_id=? LIMIT 1
      `).get(eventId, kind, itemId, agentId);
      if (seen) return rowById(seen.id);
    }
    const existing = live(itemId, harness);
    if (existing) {
      if (existing.status === "active") return rowById(existing.id);
      if (existing.event_id === eventId && existing.agent_id === agentId && existing.kind === kind) {
        return rowById(existing.id);
      }
      const reset = existing.status === "offered" || existing.status === "accepted" || existing.status === "expired";
      if (reset) endAttempts([existing.id], at);
      db.prepare(`
        UPDATE admission_queue
           SET kind=?, agent_id=?, event_id=?, status=?
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
                  WHERE status='queued' AND ended_at IS NULL
                    AND (harness=? OR harness='*')
                  ORDER BY created_at ASC, id ASC${limit ? " LIMIT ?" : ""}`;
    return limit ? db.prepare(sql).all(harness, limit) : db.prepare(sql).all(harness);
  }

  function offers(harness) {
    return db.prepare(`SELECT * FROM admission_queue
                        WHERE status='offered' AND ended_at IS NULL
                          AND (harness=? OR harness='*')
                        ORDER BY created_at ASC, id ASC`).all(harness);
  }

  function markOffered(id, at = now()) {
    const row = db.prepare("SELECT * FROM admission_queue WHERE id=? AND status='queued' AND ended_at IS NULL").get(id);
    if (!row) return null;
    const attemptNo = db.prepare(
      "SELECT COALESCE(MAX(attempt_no),0)+1 AS n FROM admission_attempts WHERE admission_id=?"
    ).get(id).n;
    db.prepare("INSERT INTO admission_attempts(admission_id, attempt_no, offered_at) VALUES (?, ?, ?)")
      .run(id, attemptNo, at);
    const r = db.prepare("UPDATE admission_queue SET status='offered' WHERE id=? AND status='queued' AND ended_at IS NULL")
      .run(id);
    if (r.changes === 0) {
      db.prepare("DELETE FROM admission_attempts WHERE admission_id=? AND attempt_no=?").run(id, attemptNo);
      return null;
    }
    return rowById(id);
  }

  function fail(id, at = now()) {
    endAttempts([id], at);
    db.prepare("UPDATE admission_queue SET status='expired' WHERE id=? AND status='offered' AND ended_at IS NULL").run(id);
  }

  function activate(itemId, harness, at = now()) {
    const ids = db.prepare(`
      SELECT id FROM admission_queue
       WHERE item_id=? AND ended_at IS NULL AND status IN ('queued','offered','accepted')
         AND (harness=? OR harness='*')
    `).all(itemId, harness).map((r) => r.id);
    endAttempts(ids, at);
    db.prepare(`
      UPDATE admission_queue SET status='active'
       WHERE item_id=? AND ended_at IS NULL AND status IN ('queued','offered','accepted')
         AND (harness=? OR harness='*')
    `).run(itemId, harness);
  }

  function release(itemId, status, at = now(), exceptEventId = null) {
    const terminal = status === "done" || status === "cancelled";
    const skip = exceptEventId != null ? " AND (event_id IS NULL OR event_id != ?)" : "";
    const args = exceptEventId != null ? [itemId, exceptEventId] : [itemId];
    const ids = db.prepare(`SELECT id FROM admission_queue WHERE item_id=? AND ended_at IS NULL${skip}`)
      .all(...args).map((r) => r.id);
    endAttempts(ids, at);
    const sql = `UPDATE admission_queue SET status=?, ended_at=? WHERE item_id=? AND ended_at IS NULL${skip}`;
    const updateArgs = [terminal ? status : "done", at, ...args];
    db.prepare(sql).run(...updateArgs);
  }

  function expire({ at = now(), offerMs, baseBackoffMs, maxBackoffMs, maxAttempts }) {
    const rows = db.prepare(`
      SELECT q.id, q.kind, q.status, a.attempt_no, a.offered_at, a.accepted_at
        FROM admission_queue q
        JOIN admission_attempts a ON a.admission_id=q.id AND a.ended_at IS NULL
       WHERE q.status IN ('offered','accepted') AND q.ended_at IS NULL
         AND COALESCE(a.accepted_at, a.offered_at) + ? < ?
    `).all(offerMs, at);
    for (const row of rows) {
      db.prepare("UPDATE admission_attempts SET ended_at=? WHERE admission_id=? AND attempt_no=?")
        .run(at, row.id, row.attempt_no);
      // Append and review wakes have no claim to confirm; once offered, they
      // are one-shot, so TTL ends them instead of re-waking the planner.
      if ((row.status === "offered" || row.status === "accepted") && (row.kind === "append" || row.kind === "review")) {
        db.prepare("UPDATE admission_queue SET status='done', ended_at=? WHERE id=?").run(at, row.id);
        continue;
      }
      const attempts = attemptCount(row.id);
      db.prepare("UPDATE admission_queue SET status='expired', ended_at=? WHERE id=?")
        .run(attempts >= maxAttempts ? at : null, row.id);
    }
    const expired = db.prepare(`
      SELECT q.id, COUNT(a.attempt_no) AS attempts, MAX(a.ended_at) AS last_ended
        FROM admission_queue q
        JOIN admission_attempts a ON a.admission_id=q.id
       WHERE q.status='expired' AND q.ended_at IS NULL
       GROUP BY q.id
    `).all();
    for (const row of expired) {
      const attempts = row.attempts || 1;
      const backoff = Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.max(0, attempts - 1));
      if ((row.last_ended ?? 0) + backoff <= at) {
        db.prepare("UPDATE admission_queue SET status='queued' WHERE id=? AND status='expired'").run(row.id);
      }
    }
  }

  function resetOffers(at = now()) {
    const ids = db.prepare("SELECT id FROM admission_queue WHERE status IN ('offered','accepted') AND ended_at IS NULL")
      .all().map((r) => r.id);
    endAttempts(ids, at);
    db.prepare("UPDATE admission_queue SET status='queued' WHERE status IN ('offered','accepted') AND ended_at IS NULL")
      .run();
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
    fail,
    activate,
    release,
    expire,
    resetOffers,
    lastEventId,
    setParentCursor,
    slots,
    slotCount,
    globalSlotCount,
  };
}
