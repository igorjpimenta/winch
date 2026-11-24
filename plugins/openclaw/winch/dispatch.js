// dispatch.js — receive wake webhooks and reconcile in-progress work.
//
// The gateway owns the HTTP route; winch POSTs { type: "wake", ... } and gets
// 202 immediately. A wake only starts a turn: the agent's MCP claim is the
// work guard, so duplicate delivery is harmless.

import { hostname } from "node:os";

export const ROUTE_PATH = "/api/winch/dispatch";
export const DEFAULT_DISPATCH_URL = "http://127.0.0.1:38293";
const MAX_BODY_BYTES = 1024 * 1024;
const INFLIGHT_TTL_MS = 35 * 60 * 1000;

function readJson(req, res) {
  return (async () => {
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
  })();
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function routeUrl(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, "")}${ROUTE_PATH}`;
}

export function registerReceiver({ api, bearer, wake, started, logger = console }) {
  api.registerHttpRoute({
    path: ROUTE_PATH,
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("allow", "POST");
        res.end(JSON.stringify({ error: "method not allowed" }));
        return;
      }
      const auth = req.headers?.authorization ?? "";
      if (!auth.startsWith("Bearer ") || auth.slice(7) !== bearer) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      const body = await readJson(req, res);
      if (body === undefined) return;
      if (body?.type === "ping") {
        json(res, 200, { ok: true, test: true });
        return;
      }
      if (body?.type !== "wake" || !body.admissionId || !body.itemId || !body.agent) {
        json(res, 400, { error: "wake payload requires admissionId, itemId, agent" });
        return;
      }
      if (body.execution === "standby") {
        json(res, 202, { ok: true, admissionId: body.admissionId, standby: true });
        return;
      }
      const key = `start:${body.admissionId}:${body.attemptNo ?? "none"}`;
      const now = Date.now();
      for (const [k, at] of started ?? []) if (now - at > INFLIGHT_TTL_MS) started.delete(k);
      if (started?.has(key)) {
        json(res, 202, { ok: true, admissionId: body.admissionId, duplicate: true });
        return;
      }
      started?.set(key, now);
      Promise.resolve(wake({
        agent: body.agent,
        message: wakeMessage(body),
        sessionKey: body.itemId,
        kind: body.kind,
        admissionId: body.admissionId,
        attemptNo: body.attemptNo,
        leaseEpoch: body.leaseEpoch ?? 0,
      })).catch((err) => {
        started?.delete(key);
        logger?.warn?.(`winch: wake ${body.itemId} failed: ${err?.message ?? err}`);
      });
      json(res, 202, { ok: true, admissionId: body.admissionId });
    },
  });
}

function dispatchAuthHeaders() {
  const headers = { "content-type": "application/json" };
  const token = String(process.env.WINCH_DISPATCH_TOKEN ?? "").trim();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function wakeMessage({ itemId, kind, admissionId, attemptNo, leaseEpoch }) {
  if (kind === "story" || kind === "append" || kind === "review") {
    return `Call backlog_accept_wake with admissionId "${admissionId}", attemptNo ${attemptNo}, and leaseEpoch ${leaseEpoch ?? 0} before working on ${itemId}.`;
  }
  // A bare item id is not a prompt: the agent must be told to claim, or it
  // answers conversationally and the admission never leaves offered.
  return `Claim task ${itemId} with backlog_claim (taskId "${itemId}"), then work it to completion.`;
}

export async function registerExecutor({ baseUrl, harness, consumerId, executorId, url, bearer, fresh = false, timeoutMs = 5000 }) {
  const res = await fetch(`${String(baseUrl).replace(/\/+$/, "")}/dispatch/register`, {
    method: "POST",
    headers: dispatchAuthHeaders(),
    body: JSON.stringify({ harness, consumerId, executorId, instanceId: executorId, url, bearer, fresh }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`dispatch register ${res.status}`);
  return res.json();
}

export async function recoverOnce({ baseUrl, harness, consumerId, executorId, wake, started, logger = console, timeoutMs = 5000 }) {
  const res = await fetch(`${String(baseUrl).replace(/\/+$/, "")}/dispatch/recover`, {
    method: "POST",
    headers: dispatchAuthHeaders(),
    body: JSON.stringify({ harness, consumerId, executorId }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`dispatch recover ${res.status}`);
  const body = await res.json();
  const now = Date.now();
  for (const [key, at] of started) if (now - at > INFLIGHT_TTL_MS) started.delete(key);

  for (const row of body?.resume ?? []) {
    if (!row?.task?.id) continue;
    const key = `resume:${row.task.id}:${row.attemptId ?? "none"}`;
    if (started.has(key)) continue;
    started.set(key, now);
    Promise.resolve(wake({
      agent: row.task.assignee_agent,
      message: resumePrompt(row),
      sessionKey: row.task.id,
      kind: "resume",
      attemptId: row.attemptId,
    })).catch((err) => {
      started.delete(key);
      logger?.warn?.(`winch: resume ${row.task.id} failed: ${err?.message ?? err}`);
    });
  }

  for (const row of body?.start ?? []) {
    if (!row?.admissionId || !row?.itemId) continue;
    const key = `start:${row.admissionId}:${row.attemptNo ?? "none"}`;
    if (started.has(key)) continue;
    started.set(key, now);
    Promise.resolve(wake({
      agent: row.agent,
      message: wakeMessage(row),
      sessionKey: row.itemId,
      kind: row.kind,
      admissionId: row.admissionId,
      attemptNo: row.attemptNo,
      leaseEpoch: row.leaseEpoch ?? 0,
    })).catch((err) => {
      started.delete(key);
      logger?.warn?.(`winch: wake ${row.itemId} failed: ${err?.message ?? err}`);
    });
  }
  return body;
}

export function resumePrompt(row) {
  const taskId = row?.task?.id ?? "(unknown)";
  const attemptId = row?.attemptId ?? null;
  const leaseEpoch = row?.leaseEpoch ?? 0;
  if (!attemptId) {
    return `Repair ${taskId}. The task is in_progress but has no live attempt. Do not call backlog_claim. Call backlog_update with taskId "${taskId}", heartbeat true, and no attemptId so the store repairs the missing attempt. If it returns stale_claim, stop. Then continue from the existing brief.`;
  }
  return `Resume ${taskId} attempt ${attemptId} leaseEpoch ${leaseEpoch}. You already own this task. Do not call backlog_claim. Call backlog_update with taskId "${taskId}", attemptId "${attemptId}", leaseEpoch ${leaseEpoch}, heartbeat true. If it returns stale_claim, stop. Then continue from the existing brief.`;
}

// Core owns the wake window (delivered-but-unsettled children, capped by
// WINCH_DISPATCH_WAKE_MAX). This guard is the fail-safe for the pump/recover
// race: one live child per admission or session key, and every exit settles
// the admission so core can release the next wake.
export function createWakeGuard(wake, { settle = null } = {}) {
  const keyFor = (payload) =>
    payload?.admissionId ? `start:${payload.admissionId}`
    : payload?.sessionKey ? `resume:${payload.sessionKey}`
    : null;
  const inflight = new Set();
  return (payload) => {
    const key = keyFor(payload);
    if (key && inflight.has(key)) return Promise.resolve({ deduped: true });
    if (key) inflight.add(key);
    return Promise.resolve()
      .then(() => wake(payload))
      .finally(() => {
        if (key) inflight.delete(key);
        if (payload?.admissionId) settle?.(payload.admissionId);
      });
  };
}

export function postSettle({ baseUrl, admissionId, consumerId = null, bearer = null, logger = null, timeoutMs = 3000 }) {
  const headers = { "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return fetch(`${String(baseUrl).replace(/\/+$/, "")}/dispatch/notify`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "settle", admissionId, consumerId }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((err) => logger?.warn?.(`winch: settle ${admissionId} failed: ${err?.message ?? err}`));
}

// The receiver is registered from plugin register() — before the gateway HTTP
// server binds; a route attached from this service start never reaches the
// live listener (observed 404 on /api/winch/dispatch). startDispatch owns only
// the register/reconcile loop.
export function startDispatch({ cfg = {}, harness = cfg.winchHarness ?? process.env.WINCH_HARNESS ?? "openclaw", wake, started = new Map(), logger = console }) {
  if (cfg.dispatchEnabled === false) return null;
  const executorId = cfg.winchExecutorId ?? process.env.WINCH_EXECUTOR_ID;
  const consumerId = cfg.winchConsumerId ?? process.env.WINCH_CONSUMER_ID ?? `${harness}:${hostname()}`;
  const bearer = process.env.WINCH_WEBHOOK_BEARER;
  if (!executorId || !bearer) {
    logger?.warn?.("winch: dispatch needs WINCH_EXECUTOR_ID and WINCH_WEBHOOK_BEARER; reconcile loop disabled");
    return null;
  }
  const baseUrl = process.env.WINCH_DISPATCH_URL ?? DEFAULT_DISPATCH_URL;
  const publicBaseUrl = cfg.dispatchPublicBaseUrl ?? process.env.WINCH_DISPATCH_PUBLIC_BASE_URL ?? "http://127.0.0.1:18789";

  let fresh = true;
  const run = async () => {
    try {
      await registerExecutor({
        baseUrl,
        harness,
        consumerId,
        executorId,
        url: routeUrl(publicBaseUrl),
        bearer,
        fresh,
      });
      fresh = false;
    } catch (err) {
      logger?.warn?.(`winch: dispatch register failed: ${err?.message ?? err}`);
      return;
    }
    try {
      await recoverOnce({ baseUrl, harness, consumerId, executorId, wake, started, logger });
    } catch (err) {
      logger?.warn?.(`winch: dispatch recover failed: ${err?.message ?? err}`);
    }
  };

  void run();
  const intervalMs = Number(cfg.dispatchReconcileMs ?? 30000);
  const timer = intervalMs > 0 ? setInterval(() => { void run(); }, intervalMs) : null;
  timer?.unref?.();

  return {
    close() {
      if (timer) clearInterval(timer);
    },
    get executorId() { return executorId; },
    get consumerId() { return consumerId; },
  };
}
