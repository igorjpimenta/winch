// Resume deliveries: the server's record of handing an in_progress attempt to
// a consumer. A resume is handed once per attempt per consumer until its lease
// expires or the receiver reports the child's exit, exactly like a wake.
export function createResumeApi({ core }) {
  const { db, now } = core;

  const rowByKey = (itemId, attemptKey, consumerId) => db.prepare(`
    SELECT * FROM resume_deliveries WHERE item_id=? AND attempt_key=? AND consumer_id=?
  `).get(itemId, attemptKey, consumerId) ?? null;

  const api = {
    ensure({ itemId, attemptKey, attemptNo = null, consumerId, at = now() }) {
      const existing = rowByKey(itemId, attemptKey, consumerId);
      if (existing) return existing;
      db.prepare(`
        INSERT INTO resume_deliveries(item_id, attempt_no, attempt_key, consumer_id, handed_at, settled_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(itemId, attemptNo, attemptKey, consumerId, at, at, at);
      return rowByKey(itemId, attemptKey, consumerId);
    },

    hand({ itemId, attemptKey, attemptNo = null, consumerId, at = now() }) {
      api.ensure({ itemId, attemptKey, attemptNo, consumerId, at });
      db.prepare(`
        UPDATE resume_deliveries
           SET handed_at=?, settled_at=NULL, attempt_no=?, updated_at=?
         WHERE item_id=? AND attempt_key=? AND consumer_id=?
      `).run(at, attemptNo, at, itemId, attemptKey, consumerId);
      return rowByKey(itemId, attemptKey, consumerId);
    },

    settle({ itemId, attemptKey = null, consumerId = null, at = now() }) {
      const where = ["item_id=?", "settled_at IS NULL"];
      const args = [itemId];
      if (attemptKey != null) { where.push("attempt_key=?"); args.push(attemptKey); }
      if (consumerId != null) { where.push("consumer_id=?"); args.push(consumerId); }
      return db.prepare(`
        UPDATE resume_deliveries SET settled_at=?, updated_at=? WHERE ${where.join(" AND ")}
      `).run(at, at, ...args).changes;
    },

    isRunning(itemId, { attemptKey = null, consumerId = null, after = 0 } = {}) {
      const where = ["item_id=?", "settled_at IS NULL", "handed_at >= ?"];
      const args = [itemId, after];
      if (attemptKey != null) { where.push("attempt_key=?"); args.push(attemptKey); }
      if (consumerId != null) { where.push("consumer_id=?"); args.push(consumerId); }
      return Boolean(db.prepare(`SELECT 1 FROM resume_deliveries WHERE ${where.join(" AND ")} LIMIT 1`).get(...args));
    },

    runningCount(consumerId, { after = 0 } = {}) {
      return db.prepare(`
        SELECT COUNT(DISTINCT item_id || '/' || attempt_key) AS n FROM resume_deliveries
         WHERE consumer_id=? AND settled_at IS NULL AND handed_at >= ?
      `).get(consumerId, after).n;
    },
  };
  return api;
}
