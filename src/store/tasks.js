// Task facade: the tool-facing task methods plus the state transition that
// ends/creates an attempt and then writes the item event.

import { TASK_STATUSES } from "../schema.js";

export function createTaskApi({ core, apis }) {
  const {
    db, cfg, now, splitSessionKey, ensureSession, systemSession,
    liveAttempt, endAttempt, createAttempt, ITEM_TERMINAL,
  } = core;

  const taskApi = {
    create({ storyId, title, description, status, executionKind, executionArgs, capabilities, assigned, assigneeHarness, id }) {
      const parent = apis.item.get(storyId, { includeDeleted: true });
      if (!parent) throw new Error(`story not found: ${storyId}`);
      if (parent.kind !== "story" && parent.kind !== "task") throw new Error(`task parent must be a story or task: ${storyId}`);
      return apis.item.create({
        id, kind: "task", parentId: storyId, title, description,
        status, executionKind: executionKind ?? "manual",
        executionArgs, capabilities,
        assigneeAgent: assigned ?? null,
        assigneeHarness: assigned ? (assigneeHarness ?? "legacy") : null,
        emit: true, note: "task created",
      });
    },
    get(id) {
      const row = apis.item.get(id);
      return row?.kind === "task" ? row : null;
    },
    list({ storyId, status, assigned, assignedHarness } = {}) {
      return apis.item.list({ kind: "task", parentId: storyId, status, assigned, assignedHarness });
    },
    update(id, patch) {
      const existing = taskApi.get(id);
      if (!existing) throw new Error(`task not found: ${id}`);
      if (patch.status && !TASK_STATUSES.includes(patch.status)) throw new Error(`invalid task status: ${patch.status}`);
      const t = patch.updatedAt ?? now();
      const nextStatus = patch.status ?? existing.status;
      const enteringGate = nextStatus === "blocked" && existing.status !== "blocked";
      const leavingBlocked = existing.status === "blocked" && nextStatus !== "blocked";
      const gateType = patch.gateType !== undefined ? patch.gateType : (enteringGate ? existing.gate_type : null);
      const resultSummary = patch.result_summary !== undefined ? patch.result_summary : undefined;
      const hasSession = patch.sessionKey || patch.harness || patch.session;
      const parsed = splitSessionKey(patch.sessionKey);
      let sessionId = patch.sessionId ?? null;
      if (!sessionId && hasSession) {
        const session = ensureSession({
          harness: patch.harness ?? parsed?.harness ?? "system",
          agentId: patch.agentId ?? patch.actor ?? existing.assignee_agent ?? "system",
          externalSessionId: patch.session ?? parsed?.session ?? "system",
          itemId: id,
        });
        sessionId = session.id;
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const live = liveAttempt(id);
        if (enteringGate) {
          const gateRecord = gateType ? { type: gateType, reason: patch.note ?? null, actor: patch.actor ?? null, openedAt: t } : null;
          if (live) {
            endAttempt(live.id, { status: gateRecord ? "gated" : "released", endedAt: t, gateRecord });
          } else if (gateRecord) {
            const session = sessionId ? { id: sessionId } : systemSession(id);
            createAttempt({ itemId: id, sessionId: session.id, status: "gated", claimedAt: t, endedAt: t, leaseSeconds: cfg.leaseSeconds, gateRecord });
          }
        } else if (live && (ITEM_TERMINAL.has(nextStatus) || nextStatus === "ready" || leavingBlocked)) {
          const status = ITEM_TERMINAL.has(nextStatus) ? nextStatus : "released";
          const result = resultSummary !== undefined ? { summary: resultSummary } : null;
          endAttempt(live.id, { status, endedAt: t, result });
        } else if (live && resultSummary !== undefined) {
          db.prepare("UPDATE attempts SET result_json=? WHERE id=?").run(JSON.stringify({ summary: resultSummary }), live.id);
        } else if (!live && (ITEM_TERMINAL.has(nextStatus) || resultSummary !== undefined)) {
          const session = sessionId ? { id: sessionId } : systemSession(id);
          createAttempt({
            itemId: id,
            sessionId: session.id,
            status: ITEM_TERMINAL.has(nextStatus) ? nextStatus : "running",
            claimedAt: existing.claimed_at ?? t,
            endedAt: ITEM_TERMINAL.has(nextStatus) ? (existing.closed_at ?? t) : null,
            leaseSeconds: cfg.leaseSeconds,
            result: resultSummary !== undefined ? { summary: resultSummary } : null,
          });
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      let assigneeHarness = patch.assignee_harness;
      if (patch.assigned !== undefined && patch.assignee_harness === undefined) {
        assigneeHarness = patch.assigned == null
          ? null
          : (patch.harness ?? parsed?.harness ?? existing.assignee_harness ?? "legacy");
      }
      const row = apis.item.update(id, {
        status: patch.status,
        title: patch.title,
        description: patch.description,
        acceptance: patch.acceptance,
        priority: patch.priority,
        size: patch.size,
        ownerTeam: patch.ownerTeam,
        executionKind: patch.execution_kind ?? patch.executionKind,
        executionArgs: patch.execution_args ?? patch.executionArgs,
        assigneeHarness,
        assigneeAgent: patch.assigned,
        capabilities: patch.capabilities,
        actor: patch.actor ?? null,
        note: patch.note ?? null,
        sessionId,
        kind: patch.kind ?? (enteringGate ? (gateType ? "gate.opened" : "task.blocked") : (leavingBlocked && existing.gate_type ? "gate.dissolved" : undefined)),
        event: patch.event,
        updatedAt: t,
      });
      return row;
    },
    delete(id) {
      const r = db.prepare("DELETE FROM items WHERE id=? AND kind='task'").run(id);
      return r.changes > 0;
    },
  };

  return taskApi;
}
