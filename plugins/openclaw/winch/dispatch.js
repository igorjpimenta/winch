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

export function wakeFor(ev, { planner = "atlas" } = {}) {
  const id = ev?.item?.id ?? ev?.task?.id ?? null;
  if (!id) return null;
  switch (ev.kind) {
    case "task.assigned": {
      const agent = ev.item?.assigned ?? ev.task?.assignee ?? null;
      if (!agent || agent === planner) return null;
      return { agent, sessionKey: `winch-task-${id}`, message: id, kind: "task" };
    }
    case "story.assigned": {
      const agent = ev.item?.assigned ?? null;
      if (!agent) return null;
      return { agent, sessionKey: `winch-story-${id}`, message: id, kind: "story" };
    }
    case "task.appended": {
      const agent = ev.epicCreatedBy ?? planner;
      return { agent, sessionKey: `winch-task-${id}`, message: id, kind: "append" };
    }
    case "epic.completed": {
      if (!id.startsWith("EPIC-")) return null;
      const agent = ev.epicCreatedBy ?? planner;
      return { agent, sessionKey: `winch-epic-${id}`, message: id, kind: "review" };
    }
    default:
      return null;
  }
}

export function createRouter({ wake, planner, now = Date.now, statePath = null, logger = null }) {
  const inflight = new Map();
  const reviewed = new Set(readReviewed(statePath));

  function rememberReview(epicId) {
    reviewed.add(epicId);
    if (!statePath) return;
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ reviewedEpics: [...reviewed].slice(-500) }));
    } catch (e) {
      logger?.warn?.(`winch: review state not written: ${e?.message ?? e}`);
    }
  }

  return {
    handle(ev) {
      const route = wakeFor(ev, { planner });
      if (!route) return null;
      const key = `${route.kind}:${route.message}`;
      if (route.kind === "review") {
        if (reviewed.has(route.message)) return null;
        rememberReview(route.message);
      } else {
        const seen = inflight.get(key);
        if (seen && now() - seen < INFLIGHT_TTL_MS) return null;
        inflight.set(key, now());
        for (const [k, at] of inflight) if (now() - at > INFLIGHT_TTL_MS) inflight.delete(k);
      }
      logger?.info?.(`winch: waking ${route.agent} for ${route.message} (${route.kind})`);
      Promise.resolve(wake(route)).catch((e) => logger?.warn?.(`winch: wake failed: ${e?.message ?? e}`));
      return route;
    },
  };
}

function readReviewed(statePath) {
  if (!statePath) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return Array.isArray(parsed?.reviewedEpics) ? parsed.reviewedEpics : [];
  } catch {
    return [];
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
