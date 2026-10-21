#!/usr/bin/env node
// watcher.js — one delivery-watcher tick: sweep expired leases, compute the
// claimable set, emit a wake manifest for the cron that drives it.
//
// Claimable-ness is a stored predicate (ready-queue SQL over deps/status
// columns), so a missed or delayed wake costs only latency — the next tick
// recomputes the same set. That loss-tolerance is the point: this script must
// never be load-bearing for correctness, only for promptness.
//
// Exit code is always 0, including on an empty tick — silence is the calling
// cron message's decision, not the script's.

import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { createStore } from "./store.js";
import { readyTasks } from "./ready-queue.js";

// An agent this busy should finish before it hears about more work. Keeps the
// wake queue from stacking claims on an already-loaded assignee — the
// deferred list is the starvation metric S3.5's burn-in reads (deferred must
// stay near zero over a healthy week). Default 2, tunable via config.
export const MAX_ACTIVE_PER_AGENT = 2;

/**
 * @returns {{ts:number, swept:string[], waits:object[], routed:object[], deferred:object[], unrouted:object[], blocked:object[], gates:object[]}}
 *   swept    — lease-expired tasks the sweep requeued or escalated this tick
 *   waits    — gate-waiting rows written this tick (24h/72h age thresholds, one per gate per level)
 *   routed   — claimable AND assigned AND assignee under the active cap: the cron wakes `assigned`
 *   deferred — claimable AND assigned BUT assignee at MAX_ACTIVE: never woken (starvation metric)
 *   unrouted — claimable but unassigned, each with idleMs since last activity: heartbeat polls own these, never woken
 */
export function tick(store, { config: override = null } = {}) {
  const cfg = override ?? store.config;
  const nowTs = Date.now();
  const swept = store.task.sweepExpired({});
  const waits = store.task.recordGateWaits({ now: nowTs });
  const claimable = readyTasks(store, { limit: cfg.scanLimit }).map((r) => ({
    taskId: r.task.id,
    title: r.task.title,
    executionKind: r.task.execution_kind,
    executionArgs: r.task.execution_args,
    assigned: r.task.assigned,
    capabilities: r.task.capabilities,
    storyId: r.story.id,
    epicId: r.epic.id,
  }));
  const blocked = store.db
    .prepare("SELECT id, title, assigned, gate_type, blocked_at FROM tasks WHERE status='blocked' ORDER BY updated_at DESC LIMIT ?")
    .all(cfg.blockedLimit);
  // Gated tasks are separated from plain blocks for visibility. Who should
  // be told about them is a subscriber decision — the events WebSocket
  // streams every row, and clients track their own seen state.
  const gates = store.db.prepare(`
    SELECT t.id, t.title, t.gate_type, t.blocked_at, t.assigned
      FROM tasks t
     WHERE t.status='blocked' AND t.gate_type IS NOT NULL
     ORDER BY t.blocked_at ASC
  `).all();
  const active = new Map();
  for (const r of store.db.prepare(
    "SELECT assigned, COUNT(*) AS n FROM tasks WHERE status='in_progress' AND assigned IS NOT NULL GROUP BY assigned"
  ).all()) {
    active.set(r.assigned, r.n);
  }
  const routed = claimable.filter(
    (c) => c.assigned && (active.get(c.assigned) ?? 0) < cfg.maxActivePerAgent
  );
  const deferred = claimable
    .filter((c) => c.assigned && (active.get(c.assigned) ?? 0) >= cfg.maxActivePerAgent)
    .map((c) => ({ ...c, activeCount: active.get(c.assigned) }));
  const unrouted = claimable
    .filter((c) => !c.assigned)
    // Waiting-age gauge: the wire streams transitions, never waiting, so the
    // manifest carries how long each unrouted task has sat idle instead.
    .map((c) => {
      const row = store.task.get(c.taskId);
      return { ...c, idleMs: row ? nowTs - (row.updated_at ?? nowTs) : 0 };
    });

  return {
    ts: nowTs,
    swept: swept.map((t) => t.id),
    waits,
    routed,
    deferred,
    unrouted,
    blocked,
    gates,
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const dbPath = process.env.WINCH_DB || process.env.BACKLOG_DB_PATH || path.join(os.homedir(), ".openclaw", "backlog", "store.sqlite");
  const store = createStore({ dbPath });
  try {
    console.log(JSON.stringify(tick(store)));
  } finally {
    store.close();
  }
}
