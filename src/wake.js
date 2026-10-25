// wake.js — after-transition webhook poster: when a mutation makes tasks
// newly ready, POST each one to the gateway hooks endpoint so OpenClaw wakes
// the routed agent. This is the sanctioned ingress (docs: inbound webhooks,
// POST /hooks/agent) — no spawned processes, no bespoke socket protocol.
//
// Mechanics, all load-bearing: handle() snapshots ready ids before each
// successful call and diffs after, using the same readyTasks the MCP queue
// mechanism provides. Only tasks that TRANSITIONED into ready (absent
// before, present after) and are still ownerless are posted — already-ready
// tasks never re-fire and claimed tasks never fire, so a slow consumer
// cannot fork duplicate turns. A per-transition cap bounds the burst when
// one completion unlocks a whole epic; overflow stays queued for the next
// mutation or tick. Posts carry a fresh Idempotency-Key each: replay
// protection comes from the claim CAS itself (a duplicate wake finds the
// task claimed and exits), which is durable where the gateway's bounded
// replay cache is not. Post failures never fail the call that triggered
// them; they log and the queue stays intact. Disabled unless hookUrl AND
// hookToken are both set — a server with no hook configured behaves exactly
// like one without this file.

import { randomUUID } from "node:crypto";
import { readyTasks } from "./ready-queue.js";

const TITLE_CLAMP = 200;

function capsOf(task, story) {
  for (const v of [task?.capabilities, story?.capabilities]) {
    if (Array.isArray(v) && v.length > 0) return v;
    if (typeof v === "string" && v.length > 0) {
      try {
        const p = JSON.parse(v);
        if (Array.isArray(p) && p.length > 0) return p;
      } catch { /* stored caps that are not JSON count as absent */ }
    }
  }
  return [];
}

// Ready ids with no agent filter: wake routing is about the task becoming
// runnable for anyone, not about one caller's view of the queue.
export function snapshotReadyIds(store) {
  return new Set(readyTasks(store).map((c) => c.task.id));
}

export function routeAgent(candidate, cfg) {
  const required = capsOf(candidate.task, candidate.story);
  const routes = cfg?.wakeRoutes ?? {};
  for (const cap of required) {
    if (typeof routes[cap] === "string" && routes[cap] !== "") return routes[cap];
  }
  const fallback = cfg?.wakeAgent ?? "";
  return fallback !== "" ? fallback : null;
}

export function buildWakeBody({ agent, task }) {
  const title = String(task.title ?? "").slice(0, TITLE_CLAMP);
  return {
    message: `winch: ${task.id} "${title}" is ready — claim it with backlog_claim and work it.`,
    agentId: agent,
    name: `winch-wake-${task.id}`,
    deliver: false,
  };
}

async function postOne({ url, token, timeoutMs, body, fetchFn, logger }) {
  const key = randomUUID();
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    logger?.warn?.(`winch: wake post for ${body.agentId}/${body.name} refused: HTTP ${res.status}.`);
    return { posted: false, status: res.status };
  }
  return { posted: true, status: res.status };
}

// Diff-then-route-then-post for one completed handler call. Returns the
// wakes fired [{ taskId, agent }] so callers (and tests) can see them.
export async function runWakes({ store, beforeIds, cfg, logger, fetchFn = fetch }) {
  if (!cfg?.hookUrl || !cfg?.hookToken) return [];
  const after = readyTasks(store);
  const fresh = after.filter(
    (c) => !beforeIds.has(c.task.id) && (c.task.assigned == null)
  );
  const max = cfg.wakeMax ?? 10;
  const overflow = Math.max(0, fresh.length - max);
  if (overflow > 0) {
    logger?.warn?.(`winch: wake overflow — ${overflow} newly-ready task(s) left for the next tick (cap ${max}).`);
  }
  const fired = [];
  for (const c of fresh.slice(0, max)) {
    const agent = routeAgent(c, cfg);
    if (agent == null) continue;
    try {
      const r = await postOne({
        url: cfg.hookUrl, token: cfg.hookToken, timeoutMs: cfg.hookTimeoutMs ?? 10000,
        body: buildWakeBody({ agent, task: c.task }), fetchFn, logger,
      });
      if (r.posted) fired.push({ taskId: c.task.id, agent });
    } catch (e) {
      logger?.warn?.(`winch: wake post failed for ${c.task.id} (queue intact): ${e?.message}`);
    }
  }
  return fired;
}
