// Human gates: open a gate while a task is ready/in_progress, and resolve it
// back to ready. Open ends any live attempt as `gated`; resolve clears the
// assignment so the task is claimable again.

export function createGateMethods({ core, apis }) {
  const {
    db, cfg, now, splitSessionKey, ensureSession,
    liveAttempt, endAttempt, createAttempt, appendEvent,
  } = core;

  return {
    openGate({ id, gateType, reason, actor = "system", harness = null, session = null }) {
      const existing = apis.task.get(id);
      if (!existing || (existing.status !== "ready" && existing.status !== "in_progress")) return null;
      const t = now();
      const parsed = splitSessionKey(session);
      db.exec("BEGIN IMMEDIATE");
      try {
        const live = liveAttempt(id);
        const gateRecord = { type: gateType, reason: reason ?? null, actor, openedAt: t };
        if (live) {
          endAttempt(live.id, { status: "gated", endedAt: t, gateRecord });
        } else {
          const s = ensureSession({
            harness: harness ?? parsed?.harness ?? "system",
            agentId: actor,
            externalSessionId: session ?? parsed?.session ?? `gate-${id}`,
            itemId: id,
            kind: "system",
          });
          createAttempt({ itemId: id, sessionId: s.id, status: "gated", claimedAt: t, endedAt: t, leaseSeconds: cfg.leaseSeconds, gateRecord });
        }
        db.prepare(`
          UPDATE item_state SET revision=revision+1, status='blocked', updated_at=? WHERE item_id=?
        `).run(t, id);
        appendEvent({
          itemId: id, fromStatus: existing.status, toStatus: "blocked", kind: "gate.opened",
          actor, note: `gate open: ${gateType}${reason ? ` — ${reason}` : ""}`, at: t,
        });
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return apis.task.get(id);
    },

    resumeGate({ id, actor = "operator", harness = null, session = null }) {
      const existing = apis.task.get(id);
      if (!existing || existing.status !== "blocked") return null;
      const t = now();
      const parsed = splitSessionKey(session);
      let sessionId = null;
      if (harness || parsed) {
        const s = ensureSession({
          harness: harness ?? parsed.harness,
          agentId: actor,
          externalSessionId: session ?? parsed.session,
          itemId: id,
          kind: "system",
        });
        sessionId = s.id;
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`
          UPDATE item_state SET revision=revision+1, status='ready', assignee_harness=NULL, assignee_agent=NULL, updated_at=?
           WHERE item_id=?
        `).run(t, id);
        appendEvent({
          itemId: id, sessionId, fromStatus: "blocked", toStatus: "ready",
          kind: "gate.resolved", actor, note: "gate resume", at: t,
        });
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return apis.task.get(id);
    },
  };
}
