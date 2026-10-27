// webhook.js — claim webhook receiver: wake the agent the moment a task is
// attributed to them.
//
// Winch POSTs {event:"task.claimed", task, session, handoff} here when a CAS
// claim lands and WINCH_CLAIM_WEBHOOK_URL points at this route (see
// src/claim-webhook.js for the payload contract). This handler verifies the
// bearer, then opens a FRESH session for the claimed task via
// scheduleSessionTurn (one-shot Cron turn, deleteAfterRun) carrying the
// receiver prompt — the new session starts with full execution context, not
// a pointer. The claiming session also gets a next-turn injection so the
// current agent sees where its claim went.
//
// Resilience order per wake: fresh session → existing claiming session →
// injection-only. Every step is independently try/caught: a host without
// session scheduling still delivers context; nothing here ever throws into
// the HTTP layer.

import { timingSafeEqual } from "node:crypto";

const MAX_BODY_BYTES = 1024 * 1024;

function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function readJson(req, res) {
  let size = 0;
  let raw = "";
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      res.statusCode = 413;
      res.end(JSON.stringify({ error: "body too large" }));
      return undefined;
    }
    raw += chunk;
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "invalid json body" }));
    return undefined;
  }
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/** Shape-guard winch webhook payloads. Returns a string error or null.
 * `webhook.test` (from `winch webhook test`) only proves URL + bearer;
 * it never wakes anyone. */
export function claimError(body) {
  if (!body || typeof body !== "object") return "body must be an object";
  if (body.event === "webhook.test") return null;
  if (body.event !== "task.claimed") return `unsupported event ${JSON.stringify(body.event)}`;
  const t = body.task;
  if (!t || typeof t.id !== "string" || !t.id) return "task.id required";
  const s = body.session;
  if (!s || typeof s.agent !== "string" || !s.agent) return "session.agent required";
  if (typeof s.sessionKey !== "string" || !s.sessionKey) return "session.sessionKey required";
  return null;
}

/** New-session key for a claimed task. Namespaced so winch turns are visible. */
export function claimSessionKey(taskId) {
  return `winch-claim-${taskId}`;
}

// ── No-Cron fallback: pending-claim queue drained by the heartbeat hook ──
// When the scheduler is unavailable the webhook cannot open a turn, so the
// claim waits here instead: the next heartbeat for that agent/session carries
// the handoff as prompt context. Entries expire (stale nags are worse than
// silence) and the map is capped; a fresh claim replaces an older one for
// the same agent. In-memory only: claims live in winch, so a restart loses
// nothing durable — the next backlog_claim re-establishes the trail.
export const PENDING_TTL_MS = 4 * 3600 * 1000;
const MAX_PENDING = 50;
const pendingClaims = new Map();

export function notePendingClaim(session, body, at = Date.now()) {
  const key = `${session.agent}\n${session.sessionKey}`;
  pendingClaims.set(key, { at, body });
  while (pendingClaims.size > MAX_PENDING) {
    pendingClaims.delete(pendingClaims.keys().next().value);
  }
}

export function pendingCount() {
  return pendingClaims.size;
}

export function clearPendingClaims() {
  pendingClaims.clear();
}

function findPending({ agentId, sessionKey }, now = Date.now()) {
  let fallback = null;
  for (const [key, entry] of pendingClaims) {
    if (now - entry.at > PENDING_TTL_MS) {
      pendingClaims.delete(key);
      continue;
    }
    const [agent, session] = key.split("\n");
    if (sessionKey && session === sessionKey) return entry;
    if (!fallback && agentId && agent === agentId) fallback = entry;
  }
  return fallback;
}

/** Heartbeat prompt contribution: the pending handoff, if any. Pure. */
export function heartbeatContext(event, now = Date.now()) {
  const entry = findPending(event ?? {}, now);
  if (!entry) return undefined;
  const taskId = entry.body?.task?.id ?? "(unknown task)";
  const prompt = entry.body?.handoff?.receiverPrompt;
  const text = typeof prompt === "string" && prompt.trim() !== ""
    ? `Winch attributed ${taskId} to you while you were away. Start it now:\n${prompt}`
    : `Winch attributed ${taskId} to you while you were away. Run backlog_claim to review it.`;
  return { appendContext: text };
}

export function registerClaimHeartbeat(api) {
  if (typeof api?.on !== "function") return false;
  api.on("heartbeat_prompt_contribution", (event) => heartbeatContext(event ?? {}));
  return true;
}

/** Handoff text for the fresh session: receiver prompt verbatim when the
 * server sent one (full context), else a composed pointer. */
export function claimMessage(body) {
  const prompt = body?.handoff?.receiverPrompt;
  if (typeof prompt === "string" && prompt.trim() !== "") return prompt;
  const t = body.task;
  const lines = [`Claimed winch task ${t.id}: ${t.title ?? "(untitled)"}`];
  if (t?.story?.acceptance) lines.push(`Acceptance: ${t.story.acceptance}`);
  if (t?.story?.title) lines.push(`Story: ${t.story.title}`);
  if (t?.epic?.title) lines.push(`Epic: ${t.epic.title}`);
  lines.push(`Report via backlog_update / resolve via backlog_done (assignee ${t.assignee ?? body?.session?.agent ?? "?"}).`);
  return lines.join("\n");
}

export function registerClaimWebhook({ api, logger }) {
  const log = logger ?? api.logger;
  api.registerHttpRoute({
    path: "/api/winch/claimed",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "POST");
        res.end(JSON.stringify({ error: "method not allowed" }));
        return;
      }
      const bearer = api.pluginConfig?.webhookBearer;
      if (typeof bearer !== "string" || bearer === "") {
        // Route registered but disarmed: operator hasn't set the shared
        // secret yet. 503, not 404 — winch retries next claim, and the
        // operator sees "not configured" instead of a mystery 404.
        json(res, 503, { error: "winch claim webhook not configured (webhookBearer)" });
        return;
      }
      const auth = req.headers?.authorization ?? "";
      if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), bearer)) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      const body = await readJson(req, res);
      if (body === undefined) return;
      const shapeErr = claimError(body);
      if (shapeErr) {
        json(res, 400, { error: shapeErr });
        return;
      }
      if (body.event === "webhook.test") {
        json(res, 200, { ok: true, test: true });
        return;
      }

      const taskId = body.task.id;
      const agent = body.session.agent;
      const claimingSession = body.session.sessionKey;
      const message = claimMessage(body);
      const workflow = api.session?.workflow;
      let scheduled = false;
      let scheduledSession = null;

      // 1) Fresh session for the claimed task — the polled decision.
      if (workflow && typeof workflow.scheduleSessionTurn === "function") {
        try {
          const h = await workflow.scheduleSessionTurn({
            sessionKey: claimSessionKey(taskId),
            message,
            agentId: agent,
            delayMs: 0,
            deleteAfterRun: true,
            tag: "winch-claim",
            name: `winch ${taskId}`,
          });
          if (h) {
            scheduled = true;
            scheduledSession = claimSessionKey(taskId);
          }
        } catch (err) {
          log?.warn?.(`winch: fresh-session turn failed, falling back: ${err?.message ?? err}`);
        }
      }
      // 2) Fallback: wake inside the claiming (existing) session — it
      // definitely exists, since it just called backlog_claim.
      if (!scheduled && workflow && typeof workflow.scheduleSessionTurn === "function") {
        try {
          const h = await workflow.scheduleSessionTurn({
            sessionKey: claimingSession,
            message,
            agentId: agent,
            delayMs: 0,
            deleteAfterRun: true,
            tag: "winch-claim",
            name: `winch ${taskId}`,
          });
          if (h) {
            scheduled = true;
            scheduledSession = claimingSession;
          }
        } catch (err) {
          log?.warn?.(`winch: fallback turn failed: ${err?.message ?? err}`);
        }
      }
      // No scheduled turn: park the claim for the heartbeat hook so the
      // next natural wake carries it (the no-Cron path).
      if (!scheduled) notePendingClaim({ agent, sessionKey: claimingSession }, body);
      // 3) Always: context injection so the claiming session sees the handoff
      // even when no turn could be scheduled (non-fatal by design).
      let injected = false;
      if (workflow && typeof workflow.enqueueNextTurnInjection === "function") {
        try {
          const r = await workflow.enqueueNextTurnInjection({
            sessionKey: claimingSession,
            agentId: agent,
            text: `Winch attributed ${taskId} to you${scheduledSession ? ` (working session: ${scheduledSession})` : ""}. ${body.handoff?.reason ?? ""}`.trim(),
          });
          injected = r?.enqueued === true;
        } catch (err) {
          log?.warn?.(`winch: injection failed: ${err?.message ?? err}`);
        }
      }
      log?.info?.(`winch: claim wake ${taskId} -> agent ${agent} (scheduled=${scheduledSession ?? "none"} injected=${injected})`);
      json(res, 200, { ok: true, taskId, scheduled, scheduledSession, injected });
    },
  });
}
