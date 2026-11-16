// dispatch.js — turn winch events into agent wakes, inside the gateway.
//
// One rule: the record is the brief. A wake carries nothing but the item id
// (TASK-…, STORY-…, EPIC-…); the agent reads it with backlog_get. Routing is
// decided by the row itself:
//
//   task.assigned    → the assignee, to claim and deliver
//   story.assigned   → the story assignee, to break it into tasks
//   task.appended    → the epic's creator, to route the new work
//   epic.completed   → the epic's creator, to review the delivery
//
// Dispatch is event-driven: the client connects to `winch serve --ws`, which
// replays recent history on connect, so a gateway restart catches up without a
// timer. Claim leases remain the only guard against double work.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_WS_URL = "ws://127.0.0.1:38291";
// A wake for an item is not repeated inside this window; the work itself has
// its own lease, this only avoids duplicate turns for one assignment row.
const INFLIGHT_TTL_MS = 35 * 60 * 1000;

export const DEFAULT_MAX_CONCURRENT = 8;

// Bounded FIFO admission for wakes. Events arrive in bursts (history replay,
// a plan creating many assigned tasks), and each wake is a full agent process:
// admitting them all at once multiplies memory by the burst size. The queue
// admits oldest-first and never drops an event; idempotency is per
// kind:message tuple, so a replayed row cannot occupy two slots.
export function createWakeQueue({ limit = DEFAULT_MAX_CONCURRENT, run, onStart = null, logger = null } = {}) {
  const n = Number(limit);
  const cap = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_CONCURRENT;
  const pending = [];
  const active = new Set();
  let running = 0;
  let pumping = false;

  const keyOf = (route) => `${route.kind}:${route.message}`;

  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (running < cap && pending.length > 0) {
        const job = pending.shift();
        running++;
        active.add(job.key);
        onStart?.(job.route);
        logger?.info?.(`winch: waking ${job.route.agent} for ${job.route.message} (${job.route.kind})`);
        let result;
        try {
          result = run(job.route);
        } catch (e) {
          logger?.warn?.(`winch: wake failed for ${job.route.message}: ${e?.message ?? e}`);
          running--;
          active.delete(job.key);
          continue;
        }
        if (result && typeof result.then === "function") {
          Promise.resolve(result)
            .catch((e) => logger?.warn?.(`winch: wake failed for ${job.route.message}: ${e?.message ?? e}`))
            .finally(() => {
              running--;
              active.delete(job.key);
              pump();
            });
        } else {
          // A synchronous wake frees its slot immediately; deferring the
          // release would make a sync harness look like a running process.
          running--;
          active.delete(job.key);
        }
      }
    } finally {
      pumping = false;
    }
  }

  return {
    enqueue(route) {
      const key = keyOf(route);
      if (active.has(key)) return false;
      const existing = pending.find((job) => job.key === key);
      if (existing) {
        // A newer epic close marker supersedes a queued review of the same epic.
        if (route.kind === "review" && (route.eventId ?? 0) > (existing.route.eventId ?? 0)) {
          existing.route = route;
          return true;
        }
        return false;
      }
      pending.push({ key, route });
      if (running >= cap) {
        logger?.info?.(`winch: queued ${route.agent} for ${route.message} (${route.kind}); ${pending.length} waiting`);
      }
      pump();
      return true;
    },
    cancel(key) {
      const i = pending.findIndex((job) => job.key === key);
      if (i === -1) return false;
      pending.splice(i, 1);
      return true;
    },
    has(key) {
      return active.has(key) || pending.some((job) => job.key === key);
    },
    get pending() { return pending.length; },
    get running() { return running; },
    get limit() { return cap; },
  };
}

export function wakeFor(ev, { planner = "atlas" } = {}) {
  const id = ev?.item?.id ?? ev?.task?.id ?? null;
  if (!id) return null;
  switch (ev.kind) {
    case "task.assigned": {
      // History replay reaches here on connect: a closed or claimed task must
      // not wake anyone just because its assignment row is recent.
      if (ev.item?.status && ev.item.status !== "todo") return null;
      const agent = ev.item?.assigned ?? ev.task?.assignee ?? null;
      if (!agent || agent === planner) return null;
      return { agent, sessionKey: `winch-task-${id}`, message: id, kind: "task" };
    }
    case "story.assigned": {
      if (ev.item?.status && !["ready", "in_progress", "backlog"].includes(ev.item.status)) return null;
      const agent = ev.item?.assigned ?? null;
      if (!agent) return null;
      return { agent, sessionKey: `winch-story-${id}`, message: id, kind: "story" };
    }
    case "task.restored": {
      // Restoring brings work back without an assignment row; the assignee it
      // already had must be woken or the task sits until something else fires.
      if (ev.item?.status && ev.item.status !== "todo") return null;
      const agent = ev.item?.assigned ?? null;
      if (!agent || agent === planner) return null;
      return { agent, sessionKey: `winch-task-${id}`, message: id, kind: "task" };
    }
    case "task.appended": {
      if (ev.item?.status && ev.item.status !== "todo") return null;
      const agent = ev.epicCreatedBy ?? planner;
      return { agent, sessionKey: `winch-task-${id}`, message: id, kind: "append" };
    }
    case "epic.completed": {
      if (!id.startsWith("EPIC-")) return null;
      const agent = ev.epicCreatedBy ?? planner;
      return { agent, sessionKey: `winch-epic-${id}`, message: id, kind: "review", eventId: ev.id ?? null };
    }
    default:
      return null;
  }
}

export function createRouter({ wake, planner, maxConcurrent = DEFAULT_MAX_CONCURRENT, now = Date.now, statePath = null, logger = null }) {
  const inflight = new Map();
  const reviewedIds = readReviewed(statePath); // epicId -> last reviewed event id
  // Rows are replayed on every reconnect; each row is acted on once, while a
  // later row about the same task may still wake it again.
  const seenRows = new Set();
  const seenOrder = [];

  function rememberReview(epicId, eventId) {
    reviewedIds[epicId] = eventId ?? 0;
    if (!statePath) return;
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const entries = Object.entries(reviewedIds).slice(-500);
      fs.writeFileSync(statePath, JSON.stringify({ reviewedEpics: Object.fromEntries(entries) }));
    } catch (e) {
      logger?.warn?.(`winch: review state not written: ${e?.message ?? e}`);
    }
  }

  const queue = createWakeQueue({
    limit: maxConcurrent,
    run: wake,
    logger,
    onStart: (route) => {
      if (route.kind === "review") rememberReview(route.message, route.eventId ?? 0);
      else inflight.set(`${route.kind}:${route.message}`, now());
    },
  });

  function send(route) {
    const key = `${route.kind}:${route.message}`;
    if (route.kind === "review") {
      // A later marker for the same epic is a new review cycle.
      const last = reviewedIds[route.message] ?? 0;
      if (route.eventId != null && route.eventId <= last) return null;
    } else {
      const seen = inflight.get(key);
      if (seen && now() - seen < INFLIGHT_TTL_MS) return null;
      inflight.set(key, now());
      for (const [k, at] of inflight) if (now() - at > INFLIGHT_TTL_MS) inflight.delete(k);
    }
    if (!queue.enqueue(route)) return null;
    return route;
  }

  return {
    handle(ev) {
      if (ev?.id != null && seenRows.has(ev.id)) return null;
      let acted = false;
      // A close can make already-assigned tasks claimable; the envelope names
      // them so no subscriber has to recompute the dependency graph.
      for (const u of ev?.unblocked ?? []) {
        if (!u?.id) continue;
        if (!u?.assigned) { logger?.warn?.(`winch: unblocked task ${u.id} has no assignee; cannot wake`); continue; }
        if (u.assigned === planner) continue;
        // An earlier wake may have been refused as not-ready; that suppression
        // must not outlive the event that made the task claimable.
        inflight.delete(`task:${u.id}`);
        queue.cancel(`task:${u.id}`);
        if (send({ agent: u.assigned, sessionKey: `winch-task-${u.id}`, message: u.id, kind: "task" })) acted = true;
      }
      const route = wakeFor(ev, { planner });
      if (route === null && ev?.item?.id && (ev.kind === "task.assigned" || ev.kind === "story.assigned" || ev.kind === "task.restored" || ev.kind === "task.appended" || ev.kind === "epic.completed")) {
        const hasAgent = ev.kind === "task.appended" || ev.kind === "epic.completed"
          ? (ev.epicCreatedBy ?? planner)
          : (ev.item?.assigned ?? ev.task?.assignee);
        if (!hasAgent) {
          logger?.warn?.(`winch: ${ev.kind} for ${ev.item.id} has no assignee/creator; dies (no wake)`);
          // A null assignee/creator can never become routable on replay; mark
          // seen so the row does not spam the log. A later assignment emits a
          // new row that carries the real agent.
          if (ev?.id != null) {
            seenRows.add(ev.id);
            seenOrder.push(ev.id);
            if (seenOrder.length > 500) seenRows.delete(seenOrder.shift());
          }
        }
      }
      if (route && send(route)) acted = true;
      // A row is remembered only once it caused a wake: an unroutable row (an
      // older envelope, a filter hit) must stay retryable on the next replay.
      if (acted && ev?.id != null) {
        seenRows.add(ev.id);
        seenOrder.push(ev.id);
        if (seenOrder.length > 500) seenRows.delete(seenOrder.shift());
      }
      return route ?? null;
    },
  };
}

function readReviewed(statePath) {
  if (!statePath) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const value = parsed?.reviewedEpics;
    if (Array.isArray(value)) return Object.fromEntries(value.map((id) => [id, 0]));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function defaultStatePath() {
  return path.join(os.homedir(), ".openclaw", "state", "winch-plugin-dispatch.json");
}

// Thin transport around the router: reconnect forever, ignore malformed
// frames, and let history replay through the same handler as live rows.
export function startDispatchClient({ url = DEFAULT_WS_URL, router, logger = null }) {
  let ws = null;
  let stopped = false;
  let retry = null;

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(url);
    ws.addEventListener("open", () => logger?.info?.(`winch: dispatch connected ${url}`));
    ws.addEventListener("message", (m) => {
      let frame;
      try {
        frame = JSON.parse(m.data);
      } catch {
        return;
      }
      if (frame.type === "event") return router.handle(frame);
      if (frame.type === "history" && Array.isArray(frame.events)) {
        for (const ev of frame.events) router.handle(ev);
      }
    });
    ws.addEventListener("close", () => {
      if (stopped) return;
      retry = setTimeout(connect, 2000);
      retry?.unref?.();
    });
    ws.addEventListener("error", () => {});
  };

  connect();
  return {
    close() {
      stopped = true;
      if (retry) clearTimeout(retry);
      try { ws?.close(); } catch {}
    },
  };
}
