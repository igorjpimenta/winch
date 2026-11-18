// Webhook subscriptions, keyed by topic and stable id. The dispatch server is
// one consumer: it registers topic "dispatch" and reads back the endpoints it
// should wake. Harness/executor are optional target metadata, not identity.

function required(value, name) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) throw new Error(`webhook requires ${name}`);
  return s;
}

function optional(value, name) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error(`webhook ${name} must be a string`);
  const s = value.trim();
  return s || null;
}

function toWebhook(row) {
  if (!row) return null;
  return {
    topic: row.topic,
    id: row.id,
    harness: row.harness,
    executorId: row.executor_id,
    url: row.url,
    bearer: row.bearer,
    timeoutMs: row.timeout_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function createWebhookApi({ core }) {
  const { db, now } = core;

  const api = {
    upsert({ topic, id, harness = null, executorId = null, url, bearer, timeoutMs = null, at = now() }) {
      const t = required(topic, "a topic");
      const i = required(id, "an id");
      const h = optional(harness, "harness");
      const e = optional(executorId, "executorId");
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
        INSERT INTO webhooks(topic, id, harness, executor_id, url, bearer, timeout_ms, created_at, updated_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(topic, id) DO UPDATE SET harness=excluded.harness, executor_id=excluded.executor_id,
          url=excluded.url, bearer=excluded.bearer, timeout_ms=excluded.timeout_ms,
          updated_at=excluded.updated_at, last_seen_at=excluded.last_seen_at
      `).run(t, i, h, e, u.toString(), bearer, timeoutMs ?? null, at, at, at);
      return api.get({ topic: t, id: i });
    },

    remove({ topic, id }) {
      const r = db.prepare("DELETE FROM webhooks WHERE topic=? AND id=?").run(required(topic, "a topic"), required(id, "an id"));
      return r.changes > 0;
    },

    list({ topic = null, harness = null } = {}) {
      const clauses = [];
      const params = [];
      if (topic != null) { clauses.push("topic=?"); params.push(required(topic, "a topic")); }
      if (harness != null) { clauses.push("harness=?"); params.push(optional(harness, "harness")); }
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      return db.prepare(`SELECT * FROM webhooks${where} ORDER BY topic ASC, harness ASC, id ASC`)
        .all(...params).map(toWebhook);
    },

    prune({ topic, before = now() } = {}) {
      return db.prepare("DELETE FROM webhooks WHERE topic=? AND last_seen_at < ?")
        .run(required(topic, "a topic"), Number(before)).changes;
    },

    get({ topic, id }) {
      const row = db.prepare("SELECT * FROM webhooks WHERE topic=? AND id=?")
        .get(required(topic, "a topic"), required(id, "an id"));
      return toWebhook(row);
    },

    topics() {
      return db.prepare("SELECT DISTINCT topic FROM webhooks ORDER BY topic ASC")
        .all().map((r) => r.topic);
    },

    harnesses({ topic = null } = {}) {
      const rows = topic == null
        ? db.prepare("SELECT DISTINCT harness FROM webhooks WHERE harness IS NOT NULL ORDER BY harness ASC").all()
        : db.prepare("SELECT DISTINCT harness FROM webhooks WHERE topic=? AND harness IS NOT NULL ORDER BY harness ASC")
          .all(required(topic, "a topic"));
      return rows.map((r) => r.harness);
    },
  };

  return api;
}
