// Harness-scoped callback URLs. Claim checks these first; the table is a
// single row per harness, updated in place.

export function createWebhookApi({ core }) {
  const { db, now } = core;

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

  return webhookApi;
}
