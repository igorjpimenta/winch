// dispatch.js — turn winch events into agent wakes, for the opencode companion.
//
// Port of the openclaw dispatcher: the record is the brief. A wake carries
// nothing but the item id (TASK-…, STORY-…, EPIC-…); the agent reads it with
// backlog_get. Routing is decided by the row itself:
//
//   task.assigned    → the assignee, to claim and deliver
//   story.assigned   → the story assignee, to break it into tasks
//   task.appended    → the epic's creator, to route the new work
//   epic.completed   → the epic's creator, to review the delivery
//
// Dispatch is event-driven: the client connects to `winch serve --ws`, which
// replays recent history on connect, so a restart catches up without a timer.
// Claim leases remain the only guard against double work.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_WS_URL = "ws://127.0.0.1:38291";
// A wake for an item is not repeated inside this window; the work itself has
// its own lease, this only avoids duplicate turns for one assignment row.
const INFLIGHT_TTL_MS = 35 * 60 * 1000;

export function wakeFor(ev, { planner = "atlas" } = {}) {
  const id = ev?.item?.id ?? ev?.task?.id ?? null;
  if (!id) return null;
  switch (ev.kind) {
    case "task.assigned": {
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

export function createRouter({ wake, planner, now = Date.now, statePath = null, logger = null }) {
  const inflight = new Map();
  const reviewedIds = readReviewed(statePath);
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

  function send(route) {
    const key = `${route.kind}:${route.message}`;
    if (route.kind === "review") {
      const last = reviewedIds[route.message] ?? 0;
      if (route.eventId != null && route.eventId <= last) return null;
      rememberReview(route.message, route.eventId);
    } else {
      const seen = inflight.get(key);
      if (seen && now() - seen < INFLIGHT_TTL_MS) return null;
      inflight.set(key, now());
      for (const [k, at] of inflight) if (now() - at > INFLIGHT_TTL_MS) inflight.delete(k);
    }
    logger?.info?.(`winch: waking ${route.agent} for ${route.message} (${route.kind})`);
    Promise.resolve(wake(route)).catch((e) => logger?.warn?.(`winch: wake failed: ${e?.message ?? e}`));
    return route;
  }

  return {
    handle(ev) {
      if (ev?.id != null && seenRows.has(ev.id)) return null;
      let acted = false;
      for (const u of ev?.unblocked ?? []) {
        if (!u?.assigned || !u?.id || u.assigned === planner) continue;
        inflight.delete(`task:${u.id}`);
        if (send({ agent: u.assigned, sessionKey: `winch-task-${u.id}`, message: u.id, kind: "task" })) acted = true;
      }
      const route = wakeFor(ev, { planner });
      if (route && send(route)) acted = true;
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
  return path.join(os.homedir(), ".opencode", "state", "winch-plugin-dispatch.json");
}

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
