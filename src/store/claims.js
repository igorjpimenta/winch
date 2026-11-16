// Claim lifecycle: acquire a task, heartbeat its lease, release it, and the
// direct assignment path. Claim and release each write the attempt and event
// in the same BEGIN IMMEDIATE transaction.

export function createClaimMethods({ core, apis }) {
  const {
    db, cfg, now, splitSessionKey, ensureSession,
    liveAttempt, endAttempt, createAttempt, appendEvent, eventById,
  } = core;

  return {
    claim({ id, agentId, harness = null, session = null, sessionKey = null, watchdogMs = null }) {
      const row = apis.item.get(id);
      if (!row || row.kind !== "task") return null;
      const parsed = splitSessionKey(sessionKey);
      const h = harness ?? parsed?.harness ?? "system";
      const extSession = session ?? parsed?.session ?? `store-${agentId}`;
      const t = now();
      const leaseMs = watchdogMs ?? cfg.leaseSeconds * 1000;
      const leaseSeconds = Math.floor(leaseMs / 1000);
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = db.prepare(`
          UPDATE item_state SET status='in_progress', assignee_harness=?, assignee_agent=?, updated_at=?
           WHERE item_id=? AND status='todo' AND deleted_at IS NULL
             AND (assignee_agent IS NULL OR (assignee_agent=? AND (assignee_harness IS NULL OR assignee_harness='legacy' OR assignee_harness=?)))
        `).run(h, agentId, t, id, agentId, h);
        if (r.changes === 0) { db.exec("ROLLBACK"); return null; }
        // A pre-existing assignment may carry a NULL harness (legacy row);
        // the winning claim stamps the pair either way.
        db.prepare("UPDATE item_state SET assignee_harness=?, assignee_agent=? WHERE item_id=?").run(h, agentId, id);
        const sess = ensureSession({ harness: h, agentId, externalSessionId: extSession, itemId: id, kind: "claim" });
        const attempt = createAttempt({ itemId: id, sessionId: sess.id, status: "running", claimedAt: t, leaseSeconds });
        const eventId = appendEvent({
          itemId: id, attemptId: attempt.id, sessionId: sess.id,
          fromStatus: "todo", toStatus: "in_progress", kind: "task.claimed",
          actor: agentId, note: "claim", at: t,
        });
        db.exec("COMMIT");
        const task = apis.task.get(id);
        task.lastEvent = eventById(eventId);
        return task;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    assign({ id, agentId = null, harness = null, actor = "system", capabilities }) {
      const existing = apis.task.get(id);
      if (!existing) throw new Error(`task not found: ${id}`);
      const next = agentId === "" ? null : (agentId ?? null);
      if (existing.status === "in_progress" && (existing.assigned ?? null) !== next) {
        throw new Error(`${existing.id} is in_progress by ${existing.assigned ?? "nobody"}; wait for release before reassigning`);
      }
      const t = now();
      const h = next == null ? null : (harness ?? "legacy");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE item_state SET assignee_harness=?, assignee_agent=?, updated_at=? WHERE item_id=?")
          .run(h, next, t, id);
        if (capabilities !== undefined) {
          db.prepare("DELETE FROM item_tags WHERE item_id=?").run(id);
          for (const tag of capabilities ?? []) {
            db.prepare("INSERT OR IGNORE INTO item_tags(item_id, tag, source, created_at) VALUES (?, ?, ?, ?)")
              .run(id, String(tag), "assign", t);
          }
        }
        appendEvent({
          itemId: id, fromStatus: existing.status, toStatus: existing.status, kind: "task.assigned",
          actor, note: `assign ${next ?? "nobody"}`, at: t,
        });
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return apis.task.get(id);
    },

    heartbeat(id, agentId) {
      const t = now();
      let r = db.prepare(`
        UPDATE attempts SET heartbeat_at=?
         WHERE item_id=? AND ended_at IS NULL
           AND session_id IN (SELECT id FROM work_sessions WHERE agent_id=?)
      `).run(t, id, agentId);
      if (r.changes === 0) {
        // A row can be in_progress without an attempt only when it predates
        // this schema or was seeded directly. Heal it rather than refusing a
        // heartbeat the old store accepted.
        const row = apis.item.get(id);
        if (!row || row.status !== "in_progress" || row.assignee_agent !== agentId) return null;
        const session = ensureSession({
          harness: row.assignee_harness && row.assignee_harness !== "legacy" ? row.assignee_harness : "system",
          agentId, externalSessionId: `heartbeat-${id}`, itemId: id, kind: "system",
        });
        createAttempt({ itemId: id, sessionId: session.id, status: "running", claimedAt: t, leaseSeconds: cfg.leaseSeconds });
        r = db.prepare("UPDATE attempts SET heartbeat_at=? WHERE item_id=? AND ended_at IS NULL").run(t, id);
        if (r.changes === 0) return null;
      }
      db.prepare("UPDATE item_state SET updated_at=? WHERE item_id=?").run(t, id);
      return apis.task.get(id);
    },

    release(id, note = "release", at = now()) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const live = liveAttempt(id);
        if (!live) { db.exec("ROLLBACK"); return null; }
        endAttempt(live.id, { status: "released", endedAt: at });
        db.prepare("UPDATE item_state SET revision=revision+1, status='todo', updated_at=? WHERE item_id=?").run(at, id);
        const eventId = appendEvent({
          itemId: id, attemptId: live.id, sessionId: live.session_id,
          fromStatus: "in_progress", toStatus: "todo", kind: "task.released",
          actor: null, note, at,
        });
        db.exec("COMMIT");
        const task = apis.task.get(id);
        task.lastEvent = eventById(eventId);
        return task;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}
