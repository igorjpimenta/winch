// dispatch.js — receive wake webhooks and reconcile in-progress work.
//
// The gateway owns the HTTP route; winch POSTs { type: "wake", ... } and gets
// 202 immediately. A wake only starts a turn: the agent's MCP claim is the
// work guard, so duplicate delivery is harmless.

import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export const ROUTE_PATH = "/api/winch/dispatch";
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

export function defaultStatePath() {
  return path.join(os.homedir(), ".openclaw", "state", "winch-dispatch.json");
}

export function loadExecutorState(statePath = defaultStatePath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (typeof parsed?.executorId === "string" && parsed.executorId.trim()
      && typeof parsed?.bearer === "string" && parsed.bearer.trim()) {
      return { executorId: parsed.executorId.trim(), bearer: parsed.bearer.trim() };
    }
  } catch {
    // first boot
  }
  const state = {
    executorId: `openclaw-${crypto.randomUUID()}`,
    bearer: crypto.randomBytes(32).toString("hex"),
  };
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return state;
}

function routeUrl(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, "")}${ROUTE_PATH}`;
}

export function registerReceiver({ api, bearer, wake, logger = console }) {
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
      if (body?.type !== "wake" || !body.admissionId || !body.itemId || !body.agent) {
        json(res, 400, { error: "wake payload requires admissionId, itemId, agent" });
        return;
      }
      Promise.resolve(wake({
        agent: body.agent,
        message: body.itemId,
        kind: body.kind,
        admissionId: body.admissionId,
      })).catch((err) => logger?.warn?.(`winch: wake ${body.itemId} failed: ${err?.message ?? err}`));
      json(res, 202, { ok: true, admissionId: body.admissionId });
    },
  });
}

export async function registerExecutor({ baseUrl, harness, executorId, url, bearer, timeoutMs = 5000 }) {
  const res = await fetch(`${String(baseUrl).replace(/\/+$/, "")}/dispatch/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness, executorId, url, bearer }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`dispatch register ${res.status}`);
  return res.json();
}

export async function recoverOnce({ baseUrl, harness, executorId, wake, started, logger = console, timeoutMs = 5000 }) {
  const res = await fetch(`${String(baseUrl).replace(/\/+$/, "")}/dispatch/recover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness, executorId }),
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
    const key = `start:${row.admissionId}`;
    if (started.has(key)) continue;
    started.set(key, now);
    Promise.resolve(wake({
      agent: row.agent,
      message: row.itemId,
      kind: row.kind,
      admissionId: row.admissionId,
    })).catch((err) => {
      started.delete(key);
      logger?.warn?.(`winch: wake ${row.itemId} failed: ${err?.message ?? err}`);
    });
  }
  return body;
}

export function resumePrompt(row) {
  const taskId = row?.task?.id ?? "(unknown)";
  const attemptId = row?.attemptId ?? "(unknown)";
  return `Resume ${taskId} attempt ${attemptId}. You already own this task. Do not call backlog_claim. Call backlog_update with taskId "${taskId}" and attemptId "${attemptId}", heartbeat true. If it returns stale_claim, stop. Then continue from the existing brief.`;
}

export function startDispatch({ api, cfg = {}, wake, logger = console }) {
  if (cfg.dispatchEnabled === false) return null;
  const harness = cfg.dispatchHarness ?? process.env.WINCH_HARNESS ?? "openclaw";
  const baseUrl = cfg.dispatchUrl ?? process.env.WINCH_DISPATCH_URL ?? "http://127.0.0.1:38291";
  const publicBaseUrl = cfg.dispatchPublicBaseUrl ?? process.env.WINCH_DISPATCH_PUBLIC_BASE_URL ?? "http://127.0.0.1:18789";
  const statePath = cfg.dispatchStatePath ?? defaultStatePath();
  const state = loadExecutorState(statePath);
  const started = new Map();

  registerReceiver({ api, bearer: state.bearer, wake, logger });

  const run = async () => {
    try {
      await registerExecutor({
        baseUrl,
        harness,
        executorId: state.executorId,
        url: routeUrl(publicBaseUrl),
        bearer: state.bearer,
      });
    } catch (err) {
      logger?.warn?.(`winch: dispatch register failed: ${err?.message ?? err}`);
    }
    try {
      await recoverOnce({ baseUrl, harness, executorId: state.executorId, wake, started, logger });
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
    get executorId() { return state.executorId; },
  };
}
