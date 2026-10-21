// rollup.js — S3.3: what a delivery epic actually cost, and how much of the
// work was self-dispatched.
//
// Attribution model: claim events carry the claiming session's key
// (events.session_ref, schema v6); a session's full cost_by_call spend is
// attributed to the epic(s) it claimed in — wake sessions are short-lived
// (cron/heartbeat-isolated), so bleed is minimal, and sessions that touched
// 2+ epics are reported in sharedSessions rather than silently split.

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";

const DAY = 86_400_000;

export function dispatchFraction(store, { now = Date.now(), windowMs = 30 * DAY } = {}) {
  const since = now - windowMs;
  const row = store.db.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN session_ref IS NOT NULL THEN 1 ELSE 0 END), 0) AS self
      FROM events
     WHERE note = 'claim' AND at >= ?
  `).get(since);
  const total = row.total ?? 0;
  const self = row.self ?? 0;
  return {
    window: { since, now },
    total,
    selfDispatched: self,
    operatorDispatched: total - self,
    fraction: total > 0 ? self / total : 0,
  };
}

export function epicTokenRollup(store, { opsDbPath, now = Date.now(), windowMs = 30 * DAY } = {}) {
  const opsPath = opsDbPath ?? process.env.WINCH_OPS_DB ?? path.join(os.homedir(), ".winch", "ops.sqlite");
  if (!existsSync(opsPath)) {
    throw new Error(`ops DB not found: ${opsPath}; set WINCH_OPS_DB`);
  }
  const since = now - windowMs;
  const pairs = store.db.prepare(`
    SELECT DISTINCT s.epic_id AS epicId, e.session_ref AS ref
      FROM events e
      JOIN tasks   t ON t.id = e.task_id
      JOIN stories s ON s.id = t.story_id
     WHERE e.note = 'claim' AND e.session_ref IS NOT NULL AND e.at >= ?
  `).all(since);

  const byEpic = new Map();
  const epicsSeen = new Map();
  const refEpics = new Map();
  for (const p of pairs) {
    if (!byEpic.has(p.epicId)) { byEpic.set(p.epicId, []); }
    byEpic.get(p.epicId).push(p.ref);
    epicsSeen.set(p.epicId, store.epic.get(p.epicId));
    if (!refEpics.has(p.ref)) refEpics.set(p.ref, new Set());
    refEpics.get(p.ref).add(p.epicId);
  }
  const sharedSessions = [...refEpics.entries()].filter(([, s]) => s.size > 1).map(([ref]) => ref);

  const ops = new DatabaseSync(opsPath, { readOnly: true });
  try {
    const epics = [];
    const totals = { sessions: 0, calls: 0, tokens: 0, costUsd: 0 };
    for (const [epicId, refs] of byEpic) {
      const placeholders = refs.map(() => "?").join(",");
      const row = ops.prepare(`
        SELECT COUNT(*) AS calls,
               COALESCE(SUM(total_tokens), 0) AS tokens,
               COALESCE(SUM(cost_total), 0) AS cost
          FROM cost_by_call
         WHERE session_key IN (${placeholders})
      `).get(...refs);
      const entry = {
        epicId,
        title: epicsSeen.get(epicId)?.title ?? null,
        sessions: refs.length,
        calls: row.calls,
        tokens: row.tokens,
        costUsd: row.cost,
        sharedWithOtherEpics: refs.some((r) => sharedSessions.includes(r)),
      };
      epics.push(entry);
      totals.sessions += entry.sessions;
      totals.calls += entry.calls;
      totals.tokens += entry.tokens;
      totals.costUsd += entry.costUsd;
    }
    epics.sort((a, b) => b.costUsd - a.costUsd);
    return { window: { since, now }, epics, totals, sharedSessions };
  } finally {
    ops.close();
  }
}

const invokedDirectly = process.argv[1]?.endsWith("rollup.js");
if (invokedDirectly) {
  const { createStore } = await import("./store.js");
  const argv = process.argv.slice(2);
  const num = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? Number(argv[i + 1]) : dflt; };
  const store = createStore();
  try {
    const windowMs = argv.includes("--window-days") ? num("--window-days", 30) * DAY : undefined;
    const out = { dispatch: dispatchFraction(store, { windowMs }), rollup: epicTokenRollup(store, { windowMs }) };
    console.log(JSON.stringify(out, null, 2));
  } finally {
    store.close();
  }
}
