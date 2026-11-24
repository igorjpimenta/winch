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

import { pathToFileURL } from "node:url";
import { HUMAN_AGENT } from "./reserved.js";
import { createStore } from "./store/index.js";
import { readyTasks } from "./ready-queue.js";

/**
 * @returns {{ts:number, swept:string[], resolved:string[], waits:object[], routed:object[], human:object[], blocked:object[], gates:object[]}}
 *   swept    — lease-expired tasks the sweep requeued or escalated this tick
 *   resolved — dependency-wait tasks returned to ready this tick
 *   waits    — gate-waiting rows written this tick (24h/72h age thresholds, one per gate per level)
 *   routed   — claimable AND assigned: the cron wakes `assigned`
 *   human    — claimable human work: ready for a person, never woken through an agent harness
 */
export function tick(store, { config: override = null } = {}) {
  const cfg = override ?? store.config;
  const nowTs = Date.now();
  const swept = store.task.sweepExpired({});
  const resolved = store.task.resumeDependencyWaits({ at: nowTs });
  const waits = store.task.recordGateWaits({ now: nowTs });
  const claimable = readyTasks(store, { limit: cfg.scanLimit }).map((r) => ({
    taskId: r.task.id,
    title: r.task.title,
    executionKind: r.task.execution_kind,
    executionArgs: r.task.execution_args,
    assigned: r.task.assignee_agent,
    assignedHarness: r.task.assignee_harness,
    capabilities: r.task.capabilities,
    storyId: r.story.id,
    epicId: r.epic.id,
  }));
  const blocked = store.item
    .list({ kind: "task", status: "blocked" })
    .slice(0, cfg.blockedLimit)
    .map((t) => ({ id: t.id, title: t.title, assigned: t.assignee_agent, gate_type: t.gate_type, blocked_at: t.blocked_at }));
  // Gated tasks are separated from plain blocks for visibility. Who should
  // be told about them is a subscriber decision — event envelopes carry every
  // row, and webhook subscribers track their own seen state.
  const gates = store.item
    .list({ kind: "task", status: "blocked" })
    .filter((t) => t.gate_type)
    .sort((a, b) => (a.blocked_at ?? 0) - (b.blocked_at ?? 0))
    .map((t) => ({ id: t.id, title: t.title, gate_type: t.gate_type, blocked_at: t.blocked_at, assigned: t.assignee_agent }));
  const human = claimable.filter((c) => c.assigned === HUMAN_AGENT);
  const routed = claimable.filter((c) => c.assigned && c.assigned !== HUMAN_AGENT);

  return {
    ts: nowTs,
    swept: swept.map((t) => t.id),
    resolved,
    waits,
    routed,
    human,
    blocked,
    gates,
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const store = createStore();
  try {
    console.log(JSON.stringify(tick(store)));
  } finally {
    store.close();
  }
}
