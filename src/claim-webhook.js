// claim-webhook.js — push claimed-task handoffs to a harness webhook.
//
// When backlog_next wins a CAS claim, the claiming agent often sits idle
// waiting on its next heartbeat. If the operator configured a claim webhook
// (WINCH_CLAIM_WEBHOOK_URL), the winch server POSTs the handoff the moment
// the claim lands, so the harness can wake the agent — e.g. the openclaw
// companion plugin opens a fresh session with the receiver prompt — instead
// of waiting for a poll tick.
//
// Delivery is best-effort and never fails the claim: bounded timeout,
// network/HTTP errors become a logger warning. No URL configured = no-op.

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Resolve the webhook target for a claiming harness. Per-harness entry wins
 * (`claimWebhooks[harness]`); otherwise the single claimWebhookUrl/Bearer
 * acts as the fallback for all harnesses; neither means disabled. Each
 * harness gets exactly its own claims — no fan-out, no cross-harness leak.
 */
export function webhookConfig(cfg, harness = null) {
  const table = cfg?.claimWebhooks;
  if (harness && table && typeof table === "object") {
    const entry = table[harness];
    if (entry && typeof entry.url === "string" && entry.url.trim() !== "") {
      const timeoutMs = Number.isInteger(entry.timeoutMs) && entry.timeoutMs > 0
        ? entry.timeoutMs
        : (Number.isInteger(cfg?.claimWebhookTimeoutMs) && cfg.claimWebhookTimeoutMs > 0
          ? cfg.claimWebhookTimeoutMs
          : DEFAULT_TIMEOUT_MS);
      return {
        url: entry.url.trim(),
        bearer: typeof entry.bearer === "string" && entry.bearer !== "" ? entry.bearer : null,
        timeoutMs,
      };
    }
  }
  const url = typeof cfg?.claimWebhookUrl === "string" ? cfg.claimWebhookUrl.trim() : "";
  if (!url) return null;
  const bearer = typeof cfg?.claimWebhookBearer === "string" && cfg.claimWebhookBearer !== ""
    ? cfg.claimWebhookBearer
    : null;
  const timeoutMs = Number.isInteger(cfg?.claimWebhookTimeoutMs) && cfg.claimWebhookTimeoutMs > 0
    ? cfg.claimWebhookTimeoutMs
    : DEFAULT_TIMEOUT_MS;
  return { url, bearer, timeoutMs };
}

export function claimPayload({ task, story, epic, artifacts, handoff, identity, sessionKey }) {
  return {
    event: "task.claimed",
    at: Date.now(),
    task: {
      id: task.id,
      title: task.title,
      description: task.description ?? null,
      story: story ? { id: story.id, title: story.title, acceptance: story.acceptance ?? null } : null,
      epic: epic ? { id: epic.id, title: epic.title } : null,
      artifacts: artifacts ?? [],
      assignee: task.assigned ?? null,
    },
    session: {
      harness: identity.harness,
      agent: identity.agent,
      sessionKey,
    },
    handoff: handoff ?? null,
  };
}

/**
 * POST the payload as JSON. Resolves {ok:true,status} on 2xx, {ok:false,…}
 * otherwise — never throws, so callers can await it inline in the claim path
 * without risking the claim itself.
 */
export async function notifyClaim(cfg, payload, logger = null) {
  const hook = webhookConfig(cfg, payload?.session?.harness ?? null);
  if (!hook) return { ok: false, reason: "disabled" };
  try {
    const headers = { "content-type": "application/json" };
    if (hook.bearer) headers.authorization = `Bearer ${hook.bearer}`;
    const res = await fetch(hook.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(hook.timeoutMs),
    });
    if (!res.ok) {
      logger?.warn?.(`winch: claim webhook ${hook.url} -> ${res.status}`);
      return { ok: false, reason: `http_${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    logger?.warn?.(`winch: claim webhook ${hook.url} failed: ${err?.message ?? err}`);
    return { ok: false, reason: "error" };
  }
}
