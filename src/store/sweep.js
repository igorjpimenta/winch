// Lease sweeper and gate-age reminders. Both are watcher-driven ticks over
// attempts/item_events; neither spawns work.

export function createSweepMethods({ core, apis }) {
  const { db, cfg, jsonIn, appendEvent } = core;

  return {
    sweepExpired({ now: at = Date.now() } = {}) {
      const expired = db.prepare(`
        SELECT a.id, a.item_id, a.attempt_no FROM attempts a
          JOIN item_state s ON s.item_id=a.item_id
         WHERE a.ended_at IS NULL AND s.status='in_progress' AND a.expires_at < ?
      `).all(at);
      const swept = [];
      for (const e of expired) {
        const task = apis.task.release(e.item_id, "sweeper", at);
        if (!task) continue;
        if (e.attempt_no >= cfg.maxAttempts) {
          db.exec("BEGIN IMMEDIATE");
          try {
            const r = db.prepare("UPDATE item_state SET status='blocked', updated_at=? WHERE item_id=? AND status='todo'")
              .run(at, e.item_id);
            if (r.changes > 0) {
              appendEvent({
                itemId: e.item_id, fromStatus: "todo", toStatus: "blocked", kind: "task.blocked",
                actor: "sweeper", note: "blocked: max attempts", at,
              });
            }
            db.exec("COMMIT");
          } catch (err) {
            db.exec("ROLLBACK");
            throw err;
          }
          swept.push(apis.task.get(e.item_id));
        } else {
          swept.push(task);
        }
      }
      return swept;
    },

    recordGateWaits({ now: at = Date.now(), levels = null } = {}) {
      const lv = levels ?? cfg.gateWaitLevels;
      const gates = db.prepare(`
        SELECT s.item_id AS id, a.gate_record_json, a.ended_at
          FROM item_state s
          JOIN attempts a ON a.id = (
            SELECT a2.id FROM attempts a2
             WHERE a2.item_id=s.item_id AND a2.gate_record_json IS NOT NULL
             ORDER BY a2.attempt_no DESC LIMIT 1
          )
         WHERE s.status='blocked' AND s.deleted_at IS NULL
      `).all();
      const written = [];
      for (const g of gates) {
        const gate = jsonIn(g.gate_record_json) ?? {};
        const opened = gate.openedAt ?? g.ended_at;
        if (opened == null) continue;
        const age = at - opened;
        for (const { ms, label } of lv) {
          if (age < ms) continue;
          const note = `gate waiting: ${label} unanswered`;
          const dup = db.prepare("SELECT 1 FROM item_events WHERE item_id=? AND note=? AND created_at>? LIMIT 1")
            .get(g.id, note, opened);
          if (dup) continue;
          const eventId = appendEvent({
            itemId: g.id, fromStatus: "blocked", toStatus: "blocked", kind: "gate.waiting",
            actor: "watcher", note, at,
          });
          written.push({ taskId: g.id, label, eventId });
        }
      }
      return written;
    },
  };
}
