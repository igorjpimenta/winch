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

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { createStore } from "./store.js";
import { readyTasks } from "./ready-queue.js";
import { notifyGates, remindGates } from "./notify.js";

// An agent this busy should finish before it hears about more work. Keeps the
// wake queue from stacking claims on an already-loaded assignee — the
// deferred list is the starvation metric S3.5's burn-in reads (deferred must
// stay near zero over a healthy week).
export const MAX_ACTIVE_PER_AGENT = 2;

/**
 * @returns {{ts:number, swept:string[], routed:object[], deferred:object[], unrouted:object[], blocked:object[], gates:object[]}}
 *   routed   — claimable AND assigned AND assignee under the active cap: the cron wakes `assigned`
 *   deferred — claimable AND assigned BUT assignee at MAX_ACTIVE: never woken (starvation metric)
 *   unrouted — claimable but unassigned: heartbeat polls own these, never woken
 */
export function tick(store) {
  const swept = store.task.sweepExpired({});
  const claimable = readyTasks(store, { limit: 50 }).map((r) => ({
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
    .prepare("SELECT id, title, assigned, gate_type, blocked_at FROM tasks WHERE status='blocked' ORDER BY updated_at DESC LIMIT 20")
    .all();
  // Gated tasks are separated from plain blocks: only gate_type rows owe the
  // operator a ping, and needs_notify is derived from the events log so the
  // flag survives restarts and duplicate ticks.
  const gates = store.db.prepare(`
    SELECT t.id, t.title, t.gate_type, t.blocked_at, t.assigned,
           NOT EXISTS (SELECT 1 FROM events ev WHERE ev.task_id=t.id AND ev.note='gate notify') AS needs_notify
      FROM tasks t
     WHERE t.status='blocked' AND t.gate_type IS NOT NULL
     ORDER BY t.blocked_at ASC
  `).all().map((r) => ({ ...r, needsNotify: !!r.needs_notify }));
  const active = new Map();
  for (const r of store.db.prepare(
    "SELECT assigned, COUNT(*) AS n FROM tasks WHERE status='in_progress' AND assigned IS NOT NULL GROUP BY assigned"
  ).all()) {
    active.set(r.assigned, r.n);
  }
  const routed = claimable.filter(
    (c) => c.assigned && (active.get(c.assigned) ?? 0) < MAX_ACTIVE_PER_AGENT
  );
  const deferred = claimable
    .filter((c) => c.assigned && (active.get(c.assigned) ?? 0) >= MAX_ACTIVE_PER_AGENT)
    .map((c) => ({ ...c, activeCount: active.get(c.assigned) }));
  const unrouted = claimable.filter((c) => !c.assigned);

  return {
    ts: Date.now(),
    swept: swept.map((t) => t.id),
    routed,
    deferred,
    unrouted,
    blocked,
    gates,
  };
}

// Script-side Telegram send (the weekly-stats NOTIFY-node pattern): templated
// gate text, no model in the loop, credentials read from the gateway service
// env and never logged.
export function telegramSender() {
  const file = path.join(os.homedir(), ".openclaw", "service-env", "ai.openclaw.gateway.env");
  const keys = { ...process.env };
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
      if (m) keys[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* ambient env only */ }
  const token = keys.TELEGRAM_BOT_TOKEN;
  const chat = keys.TELEGRAM_OWNER_CHAT_ID;
  if (!token || !chat) return null;
  return async (text) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
    return res.ok;
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const dbPath = process.env.WINCH_DB || process.env.BACKLOG_DB_PATH || path.join(os.homedir(), ".openclaw", "backlog", "store.sqlite");
  const withNotify = process.argv.includes("--notify");
  const store = createStore({ dbPath });
  try {
    let notify = null;
    if (withNotify) {
      const send = telegramSender();
      notify = send
        ? await notifyGates(store, { send })
        : { notified: [], failed: [], skipped: "telegram credentials missing" };
      if (send) notify.remind = await remindGates(store, { send });
    }
    const manifest = tick(store);
    if (notify) manifest.notify = notify;
    console.log(JSON.stringify(manifest));
  } finally {
    store.close();
  }
}
