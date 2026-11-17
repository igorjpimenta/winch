// dispatch.js — local HTTP receiver plus recovery reconciliation for OpenCode.
//
// Winch POSTs a wake to this plugin's loopback listener and gets 202. The
// listener only starts a turn; the MCP claim is the work guard, so duplicate
// delivery is harmless. The reconciler handles restarts.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_DISPATCH_URL = "http://127.0.0.1:38291";
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
  return path.join(os.homedir(), ".opencode", "state", "winch-dispatch.json");
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
    executorId: `opencode-${crypto.randomUUID()}`,
    bearer: crypto.randomBytes(32).toString("hex"),
  };
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return state;
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

export function startDispatch({ baseUrl = DEFAULT_DISPATCH_URL, harness, wake, statePath = defaultStatePath(), logger = console, host = "127.0.0.1", port = 0, reconcileMs = 30000 } = {}) {
  const state = loadExecutorState(statePath);
  const started = new Map();
  let closed = false;
  let timer = null;
  let listener = null;

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/wake") {
      json(res, 404, { error: "not found" });
      return;
    }
    const auth = req.headers?.authorization ?? "";
    if (!auth.startsWith("Bearer ") || auth.slice(7) !== state.bearer) {
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
  });

  const run = async () => {
    if (closed) return;
    try {
      await registerExecutor({
        baseUrl,
        harness,
        executorId: state.executorId,
        url: `http://${host}:${listener.address().port}/wake`,
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

  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      listener = server;
      void run();
      if (Number(reconcileMs) > 0) {
        timer = setInterval(() => { void run(); }, Number(reconcileMs));
        timer.unref?.();
      }
      resolve({ port: listener.address().port, executorId: state.executorId });
    });
  });

  return {
    ready,
    get executorId() { return state.executorId; },
    get port() { return listener?.address()?.port ?? null; },
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
