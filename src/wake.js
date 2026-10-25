// wake.js — after-transition wake hook: when a mutation makes tasks newly
// ready, spawn a turn for the routed agent so the queue drains itself.
//
// Mechanics, all load-bearing: handle() snapshots ready ids before each
// successful call and diffs after. Only tasks that TRANSITIONED into ready
// (absent before, present after) and are still ownerless wake anyone —
// already-ready tasks never re-fire and claimed tasks never fire, so a slow
// consumer cannot fork duplicate turns. A per-transition cap bounds the
// stampede when one completion unlocks a whole epic. Spawns are detached
// argv with no shell, and both ids are charset-validated, so a hostile task
// title can never escape into the command line (the title rides inside one
// argv element, clamped). Disabled unless wakeAgent is set — a server that
// never asked to wake never spawns. Wake failures never fail the call that
// triggered them; they log and the queue stays intact for the next tick.

import { spawn } from "node:child_process";
import { readyTasks } from "./ready-queue.js";

const ID_RE = /^[A-Za-z0-9_:-]{1,64}$/;
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

function checkId(kind, value) {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new Error(`winch: wake refused — bad ${kind} ${JSON.stringify(value)}.`);
  }
  return value;
}

function defaultSpawn(bin, argv) {
  const child = spawn(bin, argv, { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

export function spawnWake({ bin, agent, task, spawnFn = defaultSpawn, logger }) {
  checkId("agent", agent);
  checkId("task", task.id);
  const title = String(task.title ?? "").slice(0, TITLE_CLAMP);
  const message = `winch: ${task.id} "${title}" is ready — claim it with backlog_claim and work it.`;
  logger?.info?.(`winch: waking ${agent} for ${task.id}`);
  return spawnFn(bin, ["agent", "--agent", agent, "--message", message]);
}

// Diff-then-route-then-spawn for one completed handler call. Returns the
// wakes fired [{ taskId, agent }] so callers (and tests) can see them.
export function runWakes({ store, beforeIds, cfg, logger, spawnFn }) {
  if (!cfg?.wakeAgent) return [];
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
    spawnWake({ bin: cfg.wakeBin ?? "openclaw", agent, task: c.task, spawnFn, logger });
    fired.push({ taskId: c.task.id, agent });
  }
  return fired;
}
