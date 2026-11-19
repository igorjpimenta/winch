// Outbound wake delivery over HTTP. Delivery is per consumer: every endpoint
// gets its own row and its own retry budget. A 2xx means the receiver accepted
// the request; the work is only accepted when the receiver wins the execution
// lease (a task claim, or the dispatcher's active-consumer lease).

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_BODY_CHARS = 500;

function hashPick(items, key) {
  if (!items.length) return null;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h * 31) + key.charCodeAt(i)) >>> 0;
  return items[h % items.length];
}

export function consumersFor(store, harness) {
  const rows = store.webhook.list({ topic: "dispatch" })
    .filter((w) => w.state !== "disabled")
    .filter((w) => harness === "*" || w.harness === harness);
  return rows;
}

export function pickConsumer(store, row) {
  const consumers = consumersFor(store, row.harness);
  return hashPick(consumers, `${row.id}:${row.attempt_no ?? 0}`)?.id ?? null;
}

export function wakePayload(row, { at = Date.now(), offerMs = 120000, execution = "active", leaseEpoch = 0 } = {}) {
  return {
    type: "wake",
    admissionId: row.id,
    itemId: row.item_id,
    attemptNo: row.attempt_no ?? null,
    kind: row.kind,
    harness: row.harness,
    agent: row.agent_id,
    eventId: row.event_id ?? null,
    offerExpiresAt: at + offerMs,
    execution,
    leaseEpoch,
    at,
  };
}

async function postWake(endpoint, payload, timeoutMs) {
  const headers = { "content-type": "application/json" };
  if (endpoint.bearer) headers.authorization = `Bearer ${endpoint.bearer}`;
  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text().catch(() => "");
    return { id: endpoint.id, status: res.status, body: text.slice(0, MAX_BODY_CHARS) };
  } catch (err) {
    return { id: endpoint.id, status: 0, error: String(err?.message ?? err) };
  }
}

function permanent(status) {
  return status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
}

export function ensureDeliveries(store, row, { at = Date.now() } = {}) {
  const consumers = consumersFor(store, row.harness);
  for (const consumer of consumers) {
    store.delivery.ensure({
      admissionId: row.id,
      attemptNo: row.attempt_no,
      consumerId: consumer.id,
      at,
    });
  }
  return consumers;
}

async function deliverOne(store, delivery, row, { config, logger, at }) {
  const endpoint = store.webhook.get({ topic: "dispatch", id: delivery.consumer_id });
  if (!endpoint || endpoint.state === "disabled") {
    store.delivery.markDead(delivery.id, { error: "consumer disabled", at });
    return { ok: false, consumerId: delivery.consumer_id, status: 0, error: "consumer disabled" };
  }
  const execution = row.active_consumer_id === delivery.consumer_id ? "active" : "standby";
  const payload = wakePayload(row, {
    offerMs: config.dispatchOfferMs,
    execution,
    leaseEpoch: row.lease_epoch ?? 0,
  });
  const timeout = endpoint.timeoutMs ?? config.webhookTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = await postWake(endpoint, payload, timeout);
  const ok = result.status >= 200 && result.status < 300;

  if (ok) {
    store.delivery.markDelivered(delivery.id, { status: result.status, at });
    store.webhook.recordSuccess({ topic: "dispatch", id: endpoint.id, at });
    return { ok: true, consumerId: endpoint.id, status: result.status, execution };
  }

  const attempts = delivery.attempts + 1;
  const maxAttempts = config.dispatchDeliveryMaxAttempts ?? 5;
  const disabled = permanent(result.status) || attempts >= maxAttempts;
  const after = store.webhook.recordFailure({
    topic: "dispatch",
    id: endpoint.id,
    status: result.status,
    error: result.error ?? result.body ?? null,
    permanent: disabled,
    threshold: config.dispatchDeliveryFailureThreshold ?? 4,
    at,
  });
  if (disabled || after?.state === "disabled") {
    store.delivery.markDead(delivery.id, { status: result.status, error: result.error ?? result.body ?? null, at });
  } else {
    const base = config.dispatchDeliveryBackoffMs ?? config.dispatchOfferBackoffMs ?? 30000;
    const max = config.dispatchDeliveryMaxBackoffMs ?? config.dispatchOfferMaxBackoffMs ?? 300000;
    const nextAt = at + Math.min(max, base * 2 ** Math.max(0, attempts - 1));
    store.delivery.markRetry(delivery.id, { status: result.status, error: result.error ?? result.body ?? null, nextAt, at });
  }
  logger?.warn?.(`winch: dispatch wake ${row.id} -> ${endpoint.id} failed (${result.status || result.error})${disabled ? " disabled" : ""}`);
  return { ok: false, consumerId: endpoint.id, status: result.status, error: result.error ?? result.body ?? null, execution };
}

export function promoteStranded(store, { at = Date.now(), config = store.config } = {}) {
  const rows = store.db.prepare(`
    SELECT q.id, q.harness, aa.attempt_no, aa.active_consumer_id
      FROM admission_queue q
      JOIN admission_attempts aa ON aa.admission_id=q.id AND aa.ended_at IS NULL
     WHERE q.status IN ('offered','accepted') AND q.ended_at IS NULL
  `).all();
  for (const row of rows) {
    const consumers = consumersFor(store, row.harness);
    if (!consumers.length) continue;
    const active = consumers.find((c) => c.id === row.active_consumer_id);
    const activeDelivery = row.active_consumer_id
      ? store.delivery.list({ admissionId: row.id, attemptNo: row.attempt_no, consumerId: row.active_consumer_id })[0]
      : null;
    if (active && activeDelivery?.status !== "dead") continue;
    const next = consumers.find((c) => c.id !== row.active_consumer_id) ?? consumers[0];
    if (!next || next.id === row.active_consumer_id) continue;
    store.db.prepare(`
      UPDATE admission_attempts SET active_consumer_id=?, lease_epoch=lease_epoch+1, lease_until=?
       WHERE admission_id=? AND attempt_no=? AND ended_at IS NULL
    `).run(next.id, at + (config.dispatchConsumerTtlMs ?? 90000), row.id, row.attempt_no);
    store.delivery.ensure({ admissionId: row.id, attemptNo: row.attempt_no, consumerId: next.id, at });
    store.delivery.resetForConsumer(row.id, row.attempt_no, next.id, { at });
  }
}

export async function deliverDue(store, { config = store.config, logger = null, at = Date.now(), admissionId = null } = {}) {
  promoteStranded(store, { at, config });
  const due = store.delivery.due(at, 200);
  const results = [];
  for (const delivery of due) {
    if (admissionId && delivery.admission_id !== admissionId) continue;
    const row = store.admission.get(delivery.admission_id);
    if (!row || !["offered", "accepted"].includes(row.status) || row.attempt_no !== delivery.attempt_no) {
      store.delivery.cancelForAttempt(delivery.admission_id, delivery.attempt_no, { at });
      continue;
    }
    results.push(await deliverOne(store, delivery, row, { config, logger, at }));
  }

  if (admissionId) {
    const row = store.admission.get(admissionId);
    if (row && ["offered", "accepted"].includes(row.status)) {
      const all = store.delivery.allForAttempt(row.id, row.attempt_no);
      if (all.length && all.every((d) => d.status === "dead")) store.admission.fail(row.id, at);
    }
  }
  return results;
}

export async function deliverWake(store, row, { config = store.config, logger = null, at = Date.now() } = {}) {
  const consumers = ensureDeliveries(store, row, { at });
  if (consumers.length === 0) {
    store.admission.fail(row.id, at);
    logger?.warn?.(`winch: no dispatch endpoint for ${row.harness}; requeueing ${row.id}`);
    return { ok: false, delivered: [], failed: [] };
  }
  const results = await deliverDue(store, { config, logger, at, admissionId: row.id });
  const delivered = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  return { ok: delivered.length > 0, delivered, failed };
}
