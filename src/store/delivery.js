// Per-consumer delivery ledger. One row per admission attempt × consumer; the
// relay retries each row independently, so one failed endpoint cannot hide
// behind another endpoint's 2xx.

export function createDeliveryApi({ core }) {
  const { db, now } = core;

  function rowById(id) {
    return db.prepare("SELECT * FROM dispatch_deliveries WHERE id=?").get(id) ?? null;
  }

  const api = {
    ensure({ admissionId, attemptNo, consumerId, at = now() }) {
      db.prepare(`
        INSERT INTO dispatch_deliveries(admission_id, attempt_no, consumer_id, status, attempts,
                                        next_at, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
        ON CONFLICT(admission_id, attempt_no, consumer_id) DO NOTHING
      `).run(admissionId, attemptNo, consumerId, at, at, at);
      return db.prepare(`
        SELECT * FROM dispatch_deliveries
         WHERE admission_id=? AND attempt_no=? AND consumer_id=?
      `).get(admissionId, attemptNo, consumerId) ?? null;
    },

    list({ admissionId = null, attemptNo = null, consumerId = null, status = null, dueAt = null, limit = null } = {}) {
      const where = [];
      const args = [];
      if (admissionId != null) { where.push("admission_id=?"); args.push(admissionId); }
      if (attemptNo != null) { where.push("attempt_no=?"); args.push(attemptNo); }
      if (consumerId != null) { where.push("consumer_id=?"); args.push(consumerId); }
      if (status != null) { where.push("status=?"); args.push(status); }
      if (dueAt != null) { where.push("next_at<=?"); args.push(dueAt); }
      const sql = `SELECT * FROM dispatch_deliveries${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
                   ORDER BY next_at ASC, id ASC${limit ? " LIMIT ?" : ""}`;
      return limit ? db.prepare(sql).all(...args, limit) : db.prepare(sql).all(...args);
    },

    due(at = now(), limit = 50) {
      return api.list({ status: "pending", dueAt: at, limit });
    },

    pendingForAttempt(admissionId, attemptNo) {
      return api.list({ admissionId, attemptNo, status: "pending" });
    },

    allForAttempt(admissionId, attemptNo) {
      return api.list({ admissionId, attemptNo });
    },

    get: rowById,

    markDelivered(id, { status = 202, at = now() } = {}) {
      db.prepare(`
        UPDATE dispatch_deliveries
           SET status='delivered', attempts=attempts+1, last_status=?, last_error=NULL,
               delivered_at=?, updated_at=?
         WHERE id=?
      `).run(status, at, at, id);
      return rowById(id);
    },

    markRetry(id, { status = null, error = null, nextAt, at = now() } = {}) {
      db.prepare(`
        UPDATE dispatch_deliveries
           SET status='pending', attempts=attempts+1, last_status=?, last_error=?,
               next_at=?, updated_at=?
         WHERE id=?
      `).run(status, error == null ? null : String(error), nextAt, at, id);
      return rowById(id);
    },

    markDead(id, { status = null, error = null, at = now() } = {}) {
      db.prepare(`
        UPDATE dispatch_deliveries
           SET status='dead', attempts=attempts+1, last_status=?, last_error=?,
               dead_at=?, updated_at=?
         WHERE id=?
      `).run(status, error == null ? null : String(error), at, at, id);
      return rowById(id);
    },

    cancelForAttempt(admissionId, attemptNo, { at = now() } = {}) {
      db.prepare(`
        UPDATE dispatch_deliveries
           SET status='cancelled', updated_at=?
         WHERE admission_id=? AND attempt_no=? AND status IN ('pending','delivering')
      `).run(at, admissionId, attemptNo);
    },

    resetForConsumer(admissionId, attemptNo, consumerId, { at = now() } = {}) {
      db.prepare(`
        UPDATE dispatch_deliveries
           SET status='pending', next_at=?, delivered_at=NULL, dead_at=NULL, updated_at=?
         WHERE admission_id=? AND attempt_no=? AND consumer_id=?
      `).run(at, at, admissionId, attemptNo, consumerId);
      return db.prepare(`
        SELECT * FROM dispatch_deliveries
         WHERE admission_id=? AND attempt_no=? AND consumer_id=?
      `).get(admissionId, attemptNo, consumerId) ?? null;
    },
  };

  return api;
}
