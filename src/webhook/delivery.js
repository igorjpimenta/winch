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

// A dead delivery is only terminal when no other consumer can take the attempt;
// otherwise promoteStranded hands it over on the next pass.
function hasSuccessor(store, row) {
  return consumersFor(store, row.harness).some((consumer) => consumer.id !== row.active_consumer_id);
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

// Only the attempt owner gets a delivery. A non-owner has no session to start
// and cannot settle, so a notice to it would hold a wake-window slot for the
// whole lease. Ownership moves through promoteStranded, which creates the
// successor's delivery.
export function ensureDeliveries(store, row, { at = Date.now() } = {}) {
  const consumers = consumersFor(store, row.harness);
  const owner = consumers.find((consumer) => consumer.id === row.active_consumer_id);
  if (!owner) return [];
  const event = row.attempt_no == null ? null : store.dispatchEvent.ensure({
    admissionId: row.id,
    attemptNo: row.attempt_no,
    itemId: row.item_id,
    sourceEventId: row.event_id ?? null,
    payload: wakePayload(row, { at, leaseEpoch: row.lease_epoch ?? 0 }),
    at,
  });
  store.delivery.ensure({
    admissionId: row.id,
    attemptNo: row.attempt_no,
    consumerId: owner.id,
    eventId: event?.id ?? null,
    at,
  });
  return [owner];
}

async function deliverOne(store, delivery, row, { config, logger, at }) {
  const endpoint = store.webhook.get({ topic: "dispatch", id: delivery.consumer_id });
  if (!endpoint || endpoint.state === "disabled") {
    store.delivery.markDead(delivery.id, { error: "consumer disabled", at });
    store.delivery.recordAttempt({ deliveryId: delivery.id, attemptNo: delivery.attempts + 1, status: "dead", error: "consumer disabled", at });
    return { ok: false, consumerId: delivery.consumer_id, status: 0, error: "consumer disabled" };
  }
  const settleAfter = at - (config.dispatchDeliveryLeaseMs ?? 300000);
  if (store.delivery.isRunning(delivery.admission_id, { consumerId: delivery.consumer_id, after: settleAfter })) {
    // A re-offer bumped attemptNo while this consumer's child for the same
    // admission is still alive; the wake would stack a second process.
    store.delivery.cancelForAttempt(delivery.admission_id, delivery.attempt_no, { at });
    return { ok: false, consumerId: delivery.consumer_id, status: 0, error: "admission running" };
  }
  if (store.delivery.runningCount(delivery.consumer_id, { after: settleAfter }) >= (config.dispatchWakeMax ?? 8)) {
    store.delivery.defer(delivery.id, { nextAt: at + 1000, at });
    return { ok: false, consumerId: delivery.consumer_id, status: 0, error: "wake window full" };
  }
  if (row.active_consumer_id !== delivery.consumer_id) {
    // Ownership moved after this row was queued; the successor has its own
    // delivery, so this one must not reach a non-owner.
    store.delivery.markDead(delivery.id, { error: "not the attempt owner", at });
    store.delivery.recordAttempt({ deliveryId: delivery.id, attemptNo: delivery.attempts + 1, status: "cancelled", error: "not the attempt owner", at });
    return { ok: false, consumerId: delivery.consumer_id, status: 0, error: "not the attempt owner" };
  }
  const execution = "active";
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
    store.delivery.recordAttempt({ deliveryId: delivery.id, attemptNo: delivery.attempts + 1, status: "delivered", responseStatus: result.status, at });
    store.dispatchEvent.markPublished({ admissionId: row.id, attemptNo: row.attempt_no, at });
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
    store.delivery.recordAttempt({ deliveryId: delivery.id, attemptNo: attempts, status: "dead", responseStatus: result.status, error: result.error ?? result.body ?? null, at });
  } else {
    const base = config.dispatchDeliveryBackoffMs ?? config.dispatchOfferBackoffMs ?? 30000;
    const max = config.dispatchDeliveryMaxBackoffMs ?? config.dispatchOfferMaxBackoffMs ?? 300000;
    const nextAt = at + Math.min(max, base * 2 ** Math.max(0, attempts - 1));
    store.delivery.markRetry(delivery.id, { status: result.status, error: result.error ?? result.body ?? null, nextAt, at });
    store.delivery.recordAttempt({ deliveryId: delivery.id, attemptNo: attempts, status: "retry", responseStatus: result.status, error: result.error ?? result.body ?? null, at });
  }
  logger?.warn?.(`winch: dispatch wake ${row.id} -> ${endpoint.id} failed (${result.status || result.error})${disabled ? " disabled" : ""}`);
  return { ok: false, consumerId: endpoint.id, status: result.status, error: result.error ?? result.body ?? null, execution };
}

export function promoteStranded(store, { at = Date.now(), config = store.config } = {}) {
  const rows = store.db.prepare(`
    SELECT q.id, q.harness, aa.attempt_no, aa.active_consumer_id, aa.lease_until
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
    const leaseLive = (row.lease_until ?? 0) > at;
    if (active && activeDelivery?.status !== "dead" && leaseLive) continue;
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
  const leaseMs = config.dispatchDeliveryLeaseMs ?? 300000;
  store.delivery.releaseStale({ before: at - leaseMs, at });
  const due = store.delivery.claimDue({ at, limit: 200, admissionId });
  const results = [];
  for (const delivery of due) {
    const row = store.admission.get(delivery.admission_id);
    if (!row || !["offered", "accepted"].includes(row.status) || row.attempt_no !== delivery.attempt_no) {
      store.delivery.cancelForAttempt(delivery.admission_id, delivery.attempt_no, { at });
      continue;
    }
    try {
      results.push(await deliverOne(store, delivery, row, { config, logger, at }));
    } catch (err) {
      const base = config.dispatchDeliveryBackoffMs ?? 30000;
      store.delivery.markRetry(delivery.id, { error: String(err?.message ?? err), nextAt: at + base, at });
      store.delivery.recordAttempt({ deliveryId: delivery.id, attemptNo: delivery.attempts + 1, status: "retry", error: String(err?.message ?? err), at });
      logger?.warn?.(`winch: delivery ${delivery.id} crashed: ${err?.message ?? err}`);
    }
  }

  if (admissionId) {
    const row = store.admission.get(admissionId);
    if (row && ["offered", "accepted"].includes(row.status)) {
      const all = store.delivery.allForAttempt(row.id, row.attempt_no);
      if (all.length && all.every((d) => d.status === "dead") && !hasSuccessor(store, row)) store.admission.fail(row.id, at);
    }
  }
  const exhausted = store.db.prepare(`
    SELECT q.id, q.harness, aa.active_consumer_id
      FROM admission_queue q
      JOIN admission_attempts aa ON aa.admission_id=q.id AND aa.ended_at IS NULL
     WHERE q.status IN ('offered','accepted') AND q.ended_at IS NULL
       AND EXISTS (SELECT 1 FROM webhook_deliveries d
                    WHERE d.admission_id=q.id AND d.attempt_no=aa.attempt_no)
       AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d
                        WHERE d.admission_id=q.id AND d.attempt_no=aa.attempt_no
                          AND d.status != 'dead')
  `).all();
  for (const row of exhausted) if (!hasSuccessor(store, row)) store.admission.fail(row.id, at);
  return results;
}

export async function deliverWake(store, row, { config = store.config, logger = null, at = Date.now() } = {}) {
  promoteStranded(store, { at, config });
  const current = store.admission.get(row.id) ?? row;
  const consumers = ensureDeliveries(store, current, { at });
  if (consumers.length === 0) {
    if (consumersFor(store, current.harness).length === 0) {
      store.admission.fail(current.id, at);
      logger?.warn?.(`winch: no dispatch endpoint for ${current.harness}; requeueing ${current.id}`);
    }
    return { ok: false, delivered: [], failed: [] };
  }
  const results = await deliverDue(store, { config, logger, at, admissionId: current.id });
  const delivered = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  return { ok: delivered.length > 0, delivered, failed };
}
