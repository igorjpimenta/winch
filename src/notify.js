// notify.js — gate notification: which human gates still owe the operator a
// Telegram ping, and the send/record cycle that settles them.
//
// Notify state lives in the events log ('gate notify' rows), not a column —
// the append-only trail stays the single source of "did we already say
// something about this gate?". A failed send writes nothing, so the next
// watcher tick retries; idempotence is the event row, not the sender.

export function gatesNeedingNotify(store) {
  return store.db.prepare(`
    SELECT t.id, t.title, t.gate_type, t.blocked_at, t.assigned,
           s.title AS story_title, s.acceptance, e.title AS epic_title
      FROM tasks t
      JOIN stories s ON s.id = t.story_id
      JOIN epics   e ON e.id = s.epic_id
     WHERE t.status = 'blocked'
       AND t.gate_type IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM events ev
          WHERE ev.task_id = t.id AND ev.note = 'gate notify'
       )
     ORDER BY t.blocked_at ASC
  `).all();
}

export function gateMessage(g) {
  return [
    `ADT gate: ${g.gate_type}`,
    `Task ${g.id}: ${g.title}`,
    `Story: ${g.story_title} (Epic: ${g.epic_title})`,
    `Blocked since ${g.blocked_at ? new Date(g.blocked_at).toISOString() : "unknown"} · assigned: ${g.assigned ?? "unassigned"}`,
    `Approve: reply "resume ${g.id}" — or run: openclaw backlog resume ${g.id}`,
  ].join("\n");
}

/**
 * Record that the operator was notified. Guard: only a real gate records one —
 * the trail must not claim a notification for a task that never gated.
 * Returns the inserted event row, or null.
 */
export function markGateNotified(store, id, actor = "watcher") {
  const cur = store.db.prepare(`
    SELECT t.status, t.gate_type,
           EXISTS (SELECT 1 FROM events ev WHERE ev.task_id=t.id AND ev.note='gate notify') AS already
      FROM tasks t WHERE t.id=?
  `).get(id);
  if (!cur || cur.status !== "blocked" || !cur.gate_type || cur.already) return null;
  const at = Date.now();
  store.db.prepare(
    "INSERT INTO events(task_id, from_status, to_status, actor, note, at) VALUES (?, 'blocked', 'blocked', ?, 'gate notify', ?)"
  ).run(id, actor, at);
  return store.db.prepare("SELECT * FROM events WHERE task_id=? AND note='gate notify' AND at=?").get(id, at);
}

/**
 * Send-then-record for every gate still owing a ping. `send(text)` returns a
 * boolean; only a truthful send records the event.
 * @returns {notified: string[], failed: string[]}
 */
export async function notifyGates(store, { send, actor = "watcher" } = {}) {
  const notified = [];
  const failed = [];
  for (const g of gatesNeedingNotify(store)) {
    let ok = false;
    try { ok = await send(gateMessage(g)); } catch { ok = false; }
    if (ok) {
      markGateNotified(store, g.id, actor);
      notified.push(g.id);
    } else {
      failed.push(g.id);
    }
  }
  return { notified, failed };
}

// ─── S2.4 reminders ──────────────────────────────────────────────────────
// One reminder per tier (24h, 72h), keyed by event row exactly like the
// initial ping: owed = gate age crosses the tier and no reminder event for
// that tier exists yet. A gate past 72h that never got its 24h ping gets the
// 72h one — louder wins, piling both is spam.

const REMINDER_TIERS_H = [24, 72];

function tierFor(hours) {
  for (const t of [...REMINDER_TIERS_H].sort((a, b) => b - a)) {
    if (hours >= t) return t;
  }
  return null;
}

export function remindersOwed(store, now = Date.now()) {
  const rows = store.db.prepare(`
    SELECT t.id, t.title, t.gate_type, t.blocked_at, t.assigned,
           s.title AS story_title, e.title AS epic_title
      FROM tasks t
      JOIN stories s ON s.id = t.story_id
      JOIN epics   e ON e.id = s.epic_id
     WHERE t.status = 'blocked' AND t.gate_type IS NOT NULL AND t.blocked_at IS NOT NULL
  `).all();
  const owed = [];
  for (const g of rows) {
    const hours = (now - g.blocked_at) / 3_600_000;
    const tier = tierFor(hours);
    if (!tier) continue;
    const exists = store.db.prepare(
      "SELECT 1 FROM events WHERE task_id=? AND note=?"
    ).get(g.id, `gate reminder ${tier}`);
    if (!exists) owed.push({ ...g, tier, hours: Math.floor(hours) });
  }
  return owed.sort((a, b) => a.blocked_at - b.blocked_at);
}

export function reminderMessage(g) {
  return [
    `ADT gate reminder ${g.tier}h: ${g.gate_type} still open`,
    `Task ${g.id}: ${g.title}`,
    `Story: ${g.story_title} (Epic: ${g.epic_title})`,
    `Open since ${new Date(g.blocked_at).toISOString()} · assigned: ${g.assigned ?? "unassigned"}`,
    `Resume: reply "resume ${g.id}" — or run: openclaw backlog resume ${g.id}`,
  ].join("\n");
}

export async function remindGates(store, { send, now = Date.now(), actor = "watcher" } = {}) {
  const reminded = [];
  const failed = [];
  for (const g of remindersOwed(store, now)) {
    let ok = false;
    try { ok = await send(reminderMessage(g)); } catch { ok = false; }
    if (ok) {
      store.db.prepare(
        "INSERT INTO events(task_id, from_status, to_status, actor, note, at) VALUES (?, 'blocked', 'blocked', ?, ?, ?)"
      ).run(g.id, actor, `gate reminder ${g.tier}`, Date.now());
      reminded.push({ id: g.id, tier: g.tier });
    } else {
      failed.push({ id: g.id, tier: g.tier });
    }
  }
  return { reminded, failed };
}
