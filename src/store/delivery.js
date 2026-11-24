// Per-consumer delivery ledger. One row per admission attempt × consumer; the
// relay retries each row independently, so one failed endpoint cannot hide
// behind another endpoint's 2xx.

export function createDeliveryApi({ core }) {
  const { db, now } = core;

  function rowById(id) {
    return db.prepare("SELECT * FROM webhook_deliveries WHERE id=?").get(id) ?? null;
  }

  const api = {
    ensure({ admissionId, attemptNo, consumerId, eventId = null, at = now() }) {
      db.prepare(`
        INSERT INTO webhook_deliveries(admission_id, attempt_no, event_id, consumer_id, status, attempts,
                                        next_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
        ON CONFLICT(admission_id, attempt_no, consumer_id) DO UPDATE SET
          event_id=COALESCE(webhook_deliveries.event_id, excluded.event_id)
      `).run(admissionId, attemptNo, eventId, consumerId, at, at, at);
      return db.prepare(`
        SELECT * FROM webhook_deliveries
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
      const sql = `SELECT * FROM webhook_deliveries${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
                   ORDER BY next_at ASC, id ASC${limit ? " LIMIT ?" : ""}`;
      return limit ? db.prepare(sql).all(...args, limit) : db.prepare(sql).all(...args);
    },

    due(at = now(), limit = 50) {
      return api.list({ status: "pending", dueAt: at, limit });
    },

    claimDue({ at = now(), limit = 50, admissionId = null } = {}) {
      const rows = admissionId
        ? db.prepare(`
            SELECT * FROM webhook_deliveries
             WHERE status='pending' AND next_at<=? AND admission_id=?
             ORDER BY next_at ASC, id ASC LIMIT ?
          `).all(at, admissionId, limit)
        : db.prepare(`
            SELECT * FROM webhook_deliveries
             WHERE status='pending' AND next_at<=?
             ORDER BY next_at ASC, id ASC LIMIT ?
          `).all(at, limit);
      const mark = db.prepare("UPDATE webhook_deliveries SET status='delivering', updated_at=? WHERE id=? AND status='pending'");
      return rows.filter((row) => mark.run(at, row.id).changes > 0)
        .map((row) => ({ ...row, status: "delivering", updated_at: at }));
    },

    releaseStale({ before, at = now() } = {}) {
      return db.prepare(`
        UPDATE webhook_deliveries SET status='pending', next_at=?, updated_at=?
         WHERE status='delivering' AND updated_at < ?
      `).run(at, at, before).changes;
    },

    recordAttempt({ deliveryId, attemptNo, status, responseStatus = null, error = null, at = now() }) {
      db.prepare(`
        INSERT INTO webhook_delivery_attempts(delivery_id, attempt_no, status, response_status, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(deliveryId, attemptNo, status, responseStatus, error == null ? null : String(error), at);
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
        UPDATE webhook_deliveries
           SET status='delivered', attempts=attempts+1, last_status=?, last_error=NULL,
               delivered_at=?, updated_at=?
         WHERE id=?
      `).run(status, at, at, id);
      return rowById(id);
    },

    // Marks a delivery as a running child without counting an HTTP attempt —
    // recover hands these rows to the receiver over its response, not the wire.
    markRunning({ admissionId, attemptNo, consumerId, at = now() }) {
      const row = api.ensure({ admissionId, attemptNo, consumerId, at });
      db.prepare(`
        UPDATE webhook_deliveries
           SET status='delivered', delivered_at=?, settled_at=NULL, updated_at=?
         WHERE id=? AND status NOT IN ('dead','cancelled')
      `).run(at, at, row.id);
      return rowById(row.id);
    },

    // The receiver reports a child exit; only a delivered row can settle, so a
    // late or duplicated settle cannot disturb a fresh attempt. Returns the
    // number of rows settled (0 means nothing was running for that key).
    settle({ admissionId, attemptNo = null, consumerId = null, at = now() }) {
      const where = ["status='delivered'", "admission_id=?"];
      const args = [admissionId];
      if (attemptNo != null) { where.push("attempt_no=?"); args.push(attemptNo); }
      if (consumerId != null) { where.push("consumer_id=?"); args.push(consumerId); }
      return db.prepare(`
        UPDATE webhook_deliveries SET settled_at=?, updated_at=?
         WHERE ${where.join(" AND ")}
      `).run(at, at, ...args).changes;
    },

    // Running = delivered, not yet settled, within the settle lease. The lease
    // is what frees the window when a receiver dies without settling; a live
    // child re-marks its row on every redundant wake, refreshing it.
    runningCount(consumerId, { after = 0 } = {}) {
      return db.prepare(`
        SELECT COUNT(DISTINCT admission_id) AS n FROM webhook_deliveries
         WHERE consumer_id=? AND status='delivered' AND settled_at IS NULL AND delivered_at >= ?
      `).get(consumerId, after).n;
    },

    runningAdmissionIds({ consumerId = null, after = 0 } = {}) {
      const where = ["status='delivered'", "settled_at IS NULL", "delivered_at >= ?"];
      const args = [after];
      if (consumerId != null) { where.push("consumer_id=?"); args.push(consumerId); }
      return new Set(db.prepare(`
        SELECT DISTINCT admission_id FROM webhook_deliveries WHERE ${where.join(" AND ")}
      `).all(...args).map((r) => r.admission_id));
    },

    isRunning(admissionId, { consumerId = null, after = 0 } = {}) {
      const where = ["admission_id=?", "status='delivered'", "settled_at IS NULL", "delivered_at >= ?"];
      const args = [admissionId, after];
      if (consumerId != null) { where.push("consumer_id=?"); args.push(consumerId); }
      return db.prepare(`SELECT 1 FROM webhook_deliveries WHERE ${where.join(" AND ")} LIMIT 1`)
        .get(...args) != null;
    },

    // Puts a claimed row back without counting an attempt: a delivery held by
    // the wake window was never actually posted.
    defer(id, { nextAt, at = now() } = {}) {
      db.prepare(`
        UPDATE webhook_deliveries SET status='pending', next_at=?, updated_at=?
         WHERE id=? AND status='delivering'
      `).run(nextAt, at, id);
      return rowById(id);
    },

    markRetry(id, { status = null, error = null, nextAt, at = now() } = {}) {
      db.prepare(`
        UPDATE webhook_deliveries
           SET status='pending', attempts=attempts+1, last_status=?, last_error=?,
               next_at=?, updated_at=?
         WHERE id=?
      `).run(status, error == null ? null : String(error), nextAt, at, id);
      return rowById(id);
    },

    markDead(id, { status = null, error = null, at = now() } = {}) {
      db.prepare(`
        UPDATE webhook_deliveries
           SET status='dead', attempts=attempts+1, last_status=?, last_error=?,
               dead_at=?, updated_at=?
         WHERE id=?
      `).run(status, error == null ? null : String(error), at, at, id);
      return rowById(id);
    },

    cancelForAttempt(admissionId, attemptNo, { at = now() } = {}) {
      db.prepare(`
        UPDATE webhook_deliveries
           SET status='cancelled', updated_at=?
         WHERE admission_id=? AND attempt_no=? AND status IN ('pending','delivering')
      `).run(at, admissionId, attemptNo);
    },

    resetForConsumer(admissionId, attemptNo, consumerId, { at = now() } = {}) {
      db.prepare(`
        UPDATE webhook_deliveries
           SET status='pending', next_at=?, delivered_at=NULL, settled_at=NULL, dead_at=NULL, updated_at=?
         WHERE admission_id=? AND attempt_no=? AND consumer_id=?
      `).run(at, at, admissionId, attemptNo, consumerId);
      return db.prepare(`
        SELECT * FROM webhook_deliveries
         WHERE admission_id=? AND attempt_no=? AND consumer_id=?
      `).get(admissionId, attemptNo, consumerId) ?? null;
    },
  };

  return api;
}
