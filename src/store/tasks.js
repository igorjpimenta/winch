// Task facade: the tool-facing task methods plus the state transition that
// ends/creates an attempt and then writes the item event.

import { depsResolved } from "../deps.js";
import { TASK_STATUSES } from "../schema.js";

export function createTaskApi({ core, apis }) {
  const {
    db, cfg, now, splitSessionKey, ensureSession, systemSession,
    liveAttempt, endAttempt, createAttempt, appendEvent, ITEM_TERMINAL,
  } = core;

  const taskApi = {
    create({ storyId, title, description, status, executionKind, executionArgs, capabilities, assigned, assigneeHarness, id, childKey, visitSeq, state }) {
      const parent = apis.item.get(storyId, { includeDeleted: true });
      if (!parent) throw new Error(`story not found: ${storyId}`);
      if (parent.kind !== "story" && parent.kind !== "task") throw new Error(`task parent must be a story or task: ${storyId}`);
      return apis.item.create({
        id, kind: "task", parentId: storyId, childKey, visitSeq, title, description,
        status, executionKind: executionKind ?? "manual",
        executionArgs, capabilities, state,
        assigneeAgent: assigned ?? null,
        assigneeHarness: assigned ? assigneeHarness : null,
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
          : (patch.harness ?? parsed?.harness ?? existing.assignee_harness);
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
    blockOnDeps({ id, note = null, childId = null, actor = "system", at = null }) {
      const existing = taskApi.get(id);
      if (!existing) throw new Error(`task not found: ${id}`);
      if (!["backlog", "ready", "in_progress"].includes(existing.status)) {
        throw new Error(`${existing.id} is ${existing.status}; cannot wait on dependencies`);
      }
      const t = at ?? now();
      const state = { ...(existing.state_json ?? {}) };
      state.wait = {
        kind: "deps",
        since: t,
        ...(childId ? { childId } : {}),
        ...(note ? { reason: note } : {}),
      };
      db.exec("BEGIN IMMEDIATE");
      try {
        const live = liveAttempt(id);
        if (live) endAttempt(live.id, { status: "released", endedAt: t });
        db.prepare("UPDATE item_state SET revision=revision+1, status='blocked', state_json=?, updated_at=? WHERE item_id=?")
          .run(JSON.stringify(state), t, id);
        appendEvent({
          itemId: id, fromStatus: existing.status, toStatus: "blocked",
          kind: "deps.waiting", actor,
          note: note ?? (childId ? `waiting on ${childId}` : "waiting on dependencies"), at: t,
        });
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return taskApi.get(id);
    },
    resumeDependencyWaits({ at = null } = {}) {
      const rows = db.prepare(`
        SELECT s.item_id, s.assignee_harness, s.assignee_agent, s.state_json
          FROM item_state s JOIN items i ON i.id = s.item_id
         WHERE i.kind = 'task' AND s.status = 'blocked' AND s.deleted_at IS NULL
           AND s.wait_kind = 'deps'
      `).all();
      const resolved = [];
      if (rows.length === 0) return resolved;
      const t = at ?? now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const dependencyView = { dep: apis.dep, item: apis.item, config: cfg };
        for (const row of rows) {
          if (!depsResolved(dependencyView, row.item_id)) continue;
          const status = row.assignee_harness && row.assignee_agent ? "ready" : "backlog";
          const state = JSON.parse(row.state_json || "{}");
          delete state.wait;
          db.prepare("UPDATE item_state SET revision=revision+1, status=?, state_json=?, updated_at=? WHERE item_id=?")
            .run(status, JSON.stringify(state), t, row.item_id);
          appendEvent({
            itemId: row.item_id, fromStatus: "blocked", toStatus: status,
            kind: "deps.resolved", actor: "system", note: "dependencies resolved", at: t,
          });
          resolved.push(row.item_id);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return resolved;
    },
    delete(id) {
      const r = db.prepare("DELETE FROM items WHERE id=? AND kind='task'").run(id);
      return r.changes > 0;
    },
  };

  return taskApi;
}
