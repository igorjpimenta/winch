// Outbound wake delivery over HTTP. A 2xx means the receiver accepted the
// request for delivery; the work is only accepted when the agent's MCP claim
// lands. Delivery is therefore at-least-once and duplicate wakes are valid.

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_BODY_CHARS = 500;

export function wakePayload(row, { at = Date.now(), offerMs = 120000 } = {}) {
  return {
    type: "wake",
    admissionId: row.id,
    itemId: row.item_id,
    kind: row.kind,
    harness: row.harness,
    agent: row.agent_id,
    eventId: row.event_id ?? null,
    offerExpiresAt: at + offerMs,
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
    return {
      executorId: endpoint.executorId,
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      body: text.slice(0, MAX_BODY_CHARS),
    };
  } catch (err) {
    return { executorId: endpoint.executorId, ok: false, status: 0, error: String(err?.message ?? err) };
  }
}

export async function deliverWake(store, row, { config = store.config, logger = null } = {}) {
  const harness = row.harness === "*" ? null : row.harness;
  const endpoints = store.webhook.list({ harness });
  if (endpoints.length === 0) {
    store.admission.fail(row.id, Date.now());
    logger?.warn?.(`winch: no dispatch endpoint for ${row.harness}; requeueing ${row.id}`);
    return { ok: false, delivered: [], failed: [] };
  }

  const payload = wakePayload(row, { offerMs: config.dispatchOfferMs });
  const fallbackTimeoutMs = config.dispatchWebhookTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results = await Promise.all(endpoints.map((endpoint) => postWake(endpoint, payload, endpoint.timeoutMs ?? fallbackTimeoutMs)));
  const delivered = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) {
    logger?.warn?.(`winch: dispatch wake ${row.id} -> ${r.executorId} failed (${r.status || r.error})`);
  }
  if (delivered.length === 0) store.admission.fail(row.id, Date.now());
  return { ok: delivered.length > 0, delivered, failed };
}
