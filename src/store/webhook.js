// Webhook endpoints. A harness registers one row per stable executor id; the
// dispatch server POSTs wake frames to that URL until the row is replaced or
// removed.

export function createWebhookApi({ core }) {
  const { db, now } = core;

  const api = {
    upsert({ harness, executorId, url, bearer, timeoutMs = null, at = now() }) {
      const h = typeof harness === "string" ? harness.trim() : "";
      const e = typeof executorId === "string" ? executorId.trim() : "";
      if (!h) throw new Error("webhook requires a harness");
      if (!e) throw new Error("webhook requires an executorId");
      let u;
      try { u = new URL(url); } catch { throw new Error(`invalid webhook url: ${JSON.stringify(url)}`); }
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error(`webhook url must be http(s): ${JSON.stringify(url)}`);
      }
      if (typeof bearer !== "string" || bearer === "") {
        throw new Error("webhook requires a bearer");
      }
      if (timeoutMs != null && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
        throw new Error(`webhook timeoutMs must be a positive integer, got ${JSON.stringify(timeoutMs)}`);
      }
      db.prepare(`
        INSERT INTO dispatch_webhooks(harness, executor_id, url, bearer, timeout_ms, created_at, updated_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(harness, executor_id) DO UPDATE SET url=excluded.url, bearer=excluded.bearer,
          timeout_ms=excluded.timeout_ms, updated_at=excluded.updated_at, last_seen_at=excluded.last_seen_at
      `).run(h, e, u.toString(), bearer, timeoutMs ?? null, at, at, at);
      return api.get({ harness: h, executorId: e });
    },

    remove({ harness, executorId }) {
      const r = db.prepare("DELETE FROM dispatch_webhooks WHERE harness=? AND executor_id=?").run(harness, executorId);
      return r.changes > 0;
    },

    list({ harness = null } = {}) {
      const rows = harness
        ? db.prepare("SELECT * FROM dispatch_webhooks WHERE harness=? ORDER BY executor_id ASC").all(harness)
        : db.prepare("SELECT * FROM dispatch_webhooks ORDER BY harness ASC, executor_id ASC").all();
      return rows.map((r) => ({
        harness: r.harness,
        executorId: r.executor_id,
        url: r.url,
        bearer: r.bearer,
        timeoutMs: r.timeout_ms,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        lastSeenAt: r.last_seen_at,
      }));
    },

    get({ harness, executorId }) {
      const r = db.prepare("SELECT * FROM dispatch_webhooks WHERE harness=? AND executor_id=?").get(harness, executorId);
      if (!r) return null;
      return {
        harness: r.harness,
        executorId: r.executor_id,
        url: r.url,
        bearer: r.bearer,
        timeoutMs: r.timeout_ms,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        lastSeenAt: r.last_seen_at,
      };
    },

    harnesses() {
      return db.prepare("SELECT DISTINCT harness FROM dispatch_webhooks ORDER BY harness ASC")
        .all().map((r) => r.harness);
    },
  };

  return api;
}
