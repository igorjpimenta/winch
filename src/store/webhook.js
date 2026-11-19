// Webhook subscriptions, keyed by topic and stable id. A subscription is a
// lease owned by one live instance: a different instance may only take over
// after the current lease expires. Harness/executor are target metadata, not
// identity.

const DEFAULT_LEASE_MS = 90000;

export class StaleRegistrationError extends Error {
  constructor(current) {
    super(`subscription is leased by ${current?.instanceId ?? "another instance"}`);
    this.name = "StaleRegistrationError";
    this.code = "stale_instance";
    this.current = current ?? null;
  }
}

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
    instanceId: row.instance_id,
    generation: row.generation,
    state: row.state,
    failureCount: row.failure_count,
    lastError: row.last_error,
    disabledAt: row.disabled_at,
    leaseUntil: row.lease_until,
  };
}

export function createWebhookApi({ core }) {
  const { db, now } = core;

  const api = {
    upsert({
      topic, id, harness = null, executorId = null, instanceId = null,
      url, bearer, timeoutMs = null, at = now(), leaseMs = DEFAULT_LEASE_MS,
    }) {
      const t = required(topic, "a topic");
      const i = required(id, "an id");
      const h = optional(harness, "harness");
      const e = optional(executorId, "executorId");
      const inst = optional(instanceId, "instanceId") ?? e ?? i;
      if (!Number.isInteger(leaseMs) || leaseMs <= 0) throw new Error("webhook leaseMs must be a positive integer");
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
      const existing = api.get({ topic: t, id: i });
      if (existing?.instanceId && existing.instanceId !== inst && existing.state !== "disabled"
          && (existing.leaseUntil ?? 0) > at) {
        throw new StaleRegistrationError(existing);
      }
      const generation = existing
        ? existing.generation + (existing.instanceId && existing.instanceId !== inst ? 1 : 0)
        : 0;
      db.prepare(`
        INSERT INTO webhooks(topic, id, harness, executor_id, url, bearer, timeout_ms, created_at, updated_at, last_seen_at,
                             instance_id, generation, state, failure_count, last_error, disabled_at, lease_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, NULL, NULL, ?)
        ON CONFLICT(topic, id) DO UPDATE SET harness=excluded.harness, executor_id=excluded.executor_id,
          url=excluded.url, bearer=excluded.bearer, timeout_ms=excluded.timeout_ms,
          updated_at=excluded.updated_at, last_seen_at=excluded.last_seen_at,
          instance_id=excluded.instance_id, generation=excluded.generation,
          state='active', failure_count=0, last_error=NULL, disabled_at=NULL, lease_until=excluded.lease_until
      `).run(t, i, h, e, u.toString(), bearer, timeoutMs ?? null, at, at, at, inst, generation, at + leaseMs);
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

    forHarness(harness, { topic = "dispatch" } = {}) {
      return db.prepare(`
        SELECT * FROM webhooks
         WHERE topic=? AND (harness=? OR harness IS NULL) AND state != 'disabled'
         ORDER BY id ASC
      `).all(required(topic, "a topic"), required(harness, "a harness")).map(toWebhook);
    },

    recordSuccess({ topic, id, at = now() }) {
      db.prepare(`
        UPDATE webhooks SET state='active', failure_count=0, last_error=NULL, disabled_at=NULL, last_seen_at=?, updated_at=?
         WHERE topic=? AND id=?
      `).run(at, at, required(topic, "a topic"), required(id, "an id"));
      return api.get({ topic, id });
    },

    recordFailure({ topic, id, status = null, error = null, permanent = false, threshold = 4, at = now() }) {
      const row = api.get({ topic, id });
      if (!row) return null;
      const failures = row.failureCount + 1;
      const disable = permanent || failures >= threshold;
      db.prepare(`
        UPDATE webhooks
           SET state=?, failure_count=?, last_error=?, disabled_at=?, updated_at=?
         WHERE topic=? AND id=?
      `).run(disable ? "disabled" : "suspect", failures,
        String(error ?? (status == null ? "unreachable" : `HTTP ${status}`)),
        disable ? at : row.disabledAt, at, required(topic, "a topic"), required(id, "an id"));
      return api.get({ topic, id });
    },

    disable({ topic, id, error = null, at = now() }) {
      db.prepare(`
        UPDATE webhooks SET state='disabled', last_error=?, disabled_at=?, updated_at=?
         WHERE topic=? AND id=?
      `).run(String(error ?? "disabled"), at, at, required(topic, "a topic"), required(id, "an id"));
      return api.get({ topic, id });
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
        ? db.prepare("SELECT DISTINCT harness FROM webhooks WHERE harness IS NOT NULL AND state != 'disabled' ORDER BY harness ASC").all()
        : db.prepare("SELECT DISTINCT harness FROM webhooks WHERE topic=? AND harness IS NOT NULL AND state != 'disabled' ORDER BY harness ASC")
          .all(required(topic, "a topic"));
      return rows.map((r) => r.harness);
    },
  };

  return api;
}
