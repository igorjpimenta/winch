// Attempt rows are the claim history: one live attempt per item, numbered
// monotonically. The lease and gate projections live on the row.

export function createAttemptApi({ core }) {
  const { db, endAttempt } = core;

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

  return attemptApi;
}
