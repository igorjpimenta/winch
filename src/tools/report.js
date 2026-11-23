// report.js — work reporting and gates: update, done, block, resume.
import { addDep, depsResolved } from "../deps.js";
import { identitySessionKey } from "../identity.js";
import { ok, err, clampNote } from "./shared.js";
import { attachArtifact, inferArtifactKind } from "../store/artifacts.js";

function checkAttemptLease(store, task, args) {
  if (!args?.attemptId) {
    const live = task?.attempt_id ? store.attempt.get(task.attempt_id) : null;
    if ((live?.lease_epoch ?? 0) > 0) {
      return err(`${task.id} is wake-owned; pass attemptId and leaseEpoch from claim or recovery.`, "stale_claim", { taskId: task.id });
    }
    return null;
  }
  const attempt = store.attempt.get(args.attemptId);
  if (!attempt || attempt.item_id !== task.id || attempt.ended_at != null) {
    return err(`${task.id} is not running attempt ${args.attemptId}; stop and re-read the task.`, "stale_claim", { taskId: task.id, attemptId: args.attemptId });
  }
  if ((attempt.lease_epoch ?? 0) > 0 && args?.leaseEpoch !== attempt.lease_epoch) {
    return err(`${task.id} attempt ${args.attemptId} is fenced by lease epoch ${attempt.lease_epoch}; stop and re-read the task.`, "stale_claim", { taskId: task.id, attemptId: args.attemptId });
  }
  return null;
}

export function createReportTools({ store, logger }) {
  return {
    async backlog_update(args, identity, cfg) {
      const agentId = identity.agent;
      const task = store.task.get(args?.taskId);
      if (!task) return err(`backlog_update: not found: ${args?.taskId}`, "not_found");
      if (task.status !== "in_progress") return err(`${task.id} is ${task.status}, not in_progress — claim it with backlog_claim first.`, "not_claimed", { taskId: task.id });
      if (task.assignee_agent !== agentId) return err(`${task.id} is assigned to ${task.assignee_agent}, not ${agentId}.`, "not_assignee", { taskId: task.id, assigned: task.assignee_agent });
      try {
        const stale = checkAttemptLease(store, task, args);
        if (stale) return stale;
        const wantHeartbeat = args?.heartbeat !== false;
        if (wantHeartbeat) {
          const beat = store.task.heartbeat(task.id, agentId, args?.attemptId ?? null, args?.leaseEpoch ?? null);
          if (beat === null) return err(`${task.id} is not running attempt ${args?.attemptId}; stop and re-read the task.`, "stale_claim", { taskId: task.id, attemptId: args?.attemptId ?? null });
        }
        const noteParts = [];
        if (args?.progressSummary) noteParts.push(`progress: ${clampNote(args.progressSummary, cfg.noteProgressLimit)}`);
        if (args?.comment) noteParts.push(`comment: ${clampNote(args.comment, cfg.noteProgressLimit)}`);
        if (args?.addArtifact) noteParts.push(`artifact: ${clampNote(typeof args.addArtifact === "string" ? args.addArtifact : args.addArtifact?.uri, cfg.noteArtifactLimit)}`);
        if (noteParts.length) {
          store.event.append({
            itemId: task.id,
            sessionId: task.session_id,
            fromStatus: task.status,
            toStatus: task.status,
            actor: agentId,
            note: noteParts.join(" | "),
          });
        }
        if (args?.addArtifact) {
          const raw = args.addArtifact;
          const uri = typeof raw === "string" ? raw : raw?.uri;
          if (uri) {
            const kind = args.addArtifactKind
              ?? (typeof raw === "object" && raw.kind ? raw.kind : null)
              ?? inferArtifactKind(uri);
            attachArtifact(store, {
              itemId: task.id,
              attemptId: task.attempt_id,
              kind,
              uri: String(uri),
              label: (typeof raw === "object" && raw.label) || null,
            });
          }
        }
        const fresh = store.task.get(task.id);
        return ok(JSON.stringify({ ok: true, task: { id: fresh.id, status: fresh.status, last_heartbeat: fresh.last_heartbeat, attempt_count: fresh.attempt_count } }), { status: "ok", taskId: task.id, agentId });
      } catch (e) {
        return err(`backlog_update failed: ${e?.message}`, "error");
      }
    },

    async backlog_done(args, identity, cfg) {
      const agentId = identity.agent;
      const sessionKey = identitySessionKey(identity);
      const task = store.task.get(args?.taskId);
      if (!task) return err(`backlog_done: not found: ${args?.taskId}`, "not_found");
      if (task.status !== "in_progress") return err(`${task.id} is ${task.status}, not in_progress.`, "not_claimed", { taskId: task.id });
      if (task.assignee_agent !== agentId) return err(`${task.id} is assigned to ${task.assignee_agent}, not ${agentId}.`, "not_assignee", { taskId: task.id, assigned: task.assignee_agent });
      const stale = checkAttemptLease(store, task, args);
      if (stale) return stale;
      try {
        const summary = clampNote(args.resultSummary, cfg.noteResultLimit);
        const artifacts = Array.isArray(args.artifacts) ? args.artifacts.slice(0, cfg.maxArtifacts) : [];
        const hitlKinds = cfg.hitlArtifactKinds ?? [];
        for (const a of artifacts) {
          const uri = typeof a === "string" ? a : a?.uri;
          const kind = (typeof a === "object" && a.kind) || inferArtifactKind(uri);
          if (hitlKinds.includes(kind)) {
            return err(
              `HITL artifact (${kind}) must be attached while in_progress via backlog_update addArtifact — it opens the human review child that gates this close: ${uri}`,
              "hitl_at_done",
              { taskId: task.id },
            );
          }
        }
        if (!depsResolved(store, task.id)) {
          const openDeps = store.dep.listOutgoing(task.id)
            .map((e) => e.to_id)
            .filter((id) => {
              const d = store.item.get(id, { includeDeleted: true });
              return d && d.status !== "done" && d.status !== "cancelled";
            });
          return err(
            `${task.id} cannot close: unresolved deps ${openDeps.join(", ")}`,
            "deps_unmet",
            { taskId: task.id, openDeps },
          );
        }
        const artifactUris = artifacts
          .map((a) => (typeof a === "string" ? a : a?.uri))
          .filter(Boolean);
        const resultSummary = artifactUris.length ? `${summary}\n\nartifacts: ${artifactUris.join(", ")}` : summary;
        const updated = store.task.update(task.id, {
          status: "done", result_summary: resultSummary, actor: agentId, note: "done",
          sessionKey, harness: identity.harness, session: identity.session, agentId,
        });
        for (const a of artifacts) {
          const uri = typeof a === "string" ? a : a?.uri;
          if (!uri) continue;
          store.artifact.add({
            itemId: task.id,
            attemptId: updated.attempt_id,
            kind: (typeof a === "object" && a.kind) || inferArtifactKind(uri),
            uri,
            label: (typeof a === "object" && a.label) || null,
          });
        }
        store.task.resumeDependencyWaits();
        // Close upward, one level at a time: a story closes when its last task
        // does, and the epic closes only when its last story does. The epic
        // row is what wakes its creator to review the delivery.
        const actor = `${identity.harness}:${identity.agent}`;
        const story = task.story_id ? store.story.get(task.story_id) : null;
        let storyClosed = false;
        if (story && story.status !== "done" && story.status !== "cancelled") {
          const openTasks = store.item.tree(story.id).filter((r) => r.kind === "task" && r.status !== "done" && r.status !== "cancelled").length;
          if (openTasks === 0) {
            store.story.update(story.id, { status: "done", actor, note: story.id });
            storyClosed = true;
          }
        }
        const epicId = task.epic_id;
        if (storyClosed && epicId) {
          const epic = store.epic.get(epicId);
          const openStories = store.item.tree(epicId).filter((r) => r.kind === "story" && r.status !== "done" && r.status !== "cancelled").length;
          // One marker per close cycle, not per epic: a review that appends
          // work reopens the epic, and its second close must wake the planner
          // again or the fix is never confirmed.
          if (openStories === 0) {
            store.epic.update(epicId, { status: "done", actor, note: epicId });
          }
        }
        logger?.info?.(`backlog: ${agentId} completed ${task.id}`);
        return ok(JSON.stringify({ ok: true, task: { id: updated.id, status: updated.status, result_summary: updated.result_summary } }), { status: "ok", taskId: task.id, agentId });
      } catch (e) {
        return err(`backlog_done failed: ${e?.message}`, "error");
      }
    },

    async backlog_block(args, identity, cfg) {
      const agentId = identity.agent;
      const task = store.task.get(args?.taskId);
      if (!task) return err(`backlog_block: not found: ${args?.taskId}`, "not_found");
      if (task.assignee_agent && task.assignee_agent !== agentId) return err(`${task.id} is assigned to ${task.assignee_agent}, not ${agentId}.`, "not_assignee", { taskId: task.id });
      if (task.status !== "in_progress" && task.status !== "ready") return err(`${task.id} is ${task.status}; blocking applies to ready/in_progress only.`, "wrong_status", { taskId: task.id });
      const stale = checkAttemptLease(store, task, args);
      if (stale) return stale;
      try {
        const reason = clampNote(args.reason, cfg.noteReasonLimit);
        let updated;
        let depResult = null;
        if (args?.gateType) {
          // Human gates open through openGate — the one path that stamps
          // gate.opened rows — never the generic update.
          updated = store.task.openGate({
            id: task.id, gateType: args.gateType, reason, actor: agentId,
            harness: identity.harness, session: identity.session,
          });
          if (!updated) return err(`${task.id} is ${store.task.get(task.id)?.status ?? "gone"}; gating applies to ready/in_progress only.`, "wrong_status", { taskId: task.id });
          if (args?.blockedBy) {
            const r = addDep(store, task.id, args.blockedBy.id);
            depResult = r.ok ? "added" : `failed:${r.code}`;
            if (r.ok) {
              store.event.append({
                itemId: task.id, fromStatus: "blocked", toStatus: "blocked",
                actor: agentId, note: `dep: ${task.id} depends on ${args.blockedBy.id}`,
              });
            }
          }
        } else if (args?.blockedBy) {
          // A dependency wait returns to ready on its own; a plain manual
          // block stays blocked until backlog_resume.
          const r = addDep(store, task.id, args.blockedBy.id);
          if (!r.ok) return err(`backlog_block: dependency rejected: ${r.code}`, "error", { taskId: task.id });
          depResult = "added";
          updated = store.task.blockOnDeps({
            id: task.id, childId: args.blockedBy.id, actor: agentId,
            note: `blocked: ${reason}; dep ${args.blockedBy.id}`,
          });
        } else {
          updated = store.task.update(task.id, {
            status: "blocked", actor: agentId, note: `blocked: ${reason}`,
            sessionKey: identitySessionKey(identity), harness: identity.harness, session: identity.session, agentId,
          });
        }
        logger?.warn?.(`backlog: ${agentId} blocked ${task.id} (${reason})`);
        return ok(JSON.stringify({ ok: true, task: { id: updated.id, status: updated.status }, dep: depResult }), { status: "ok", taskId: task.id, agentId, dep: depResult });
      } catch (e) {
        return err(`backlog_block failed: ${e?.message}`, "error");
      }
    },

    async backlog_resume(args, identity, cfg) {
      // The actor is the caller, never the caller's claim about who acts: a
      // mismatched actor would mint another key's approval on the trail.
      if (args?.actor != null && args.actor !== identity.agent) {
        return err(`backlog_resume: refused actor ${JSON.stringify(args.actor)} — approvals record the caller (${identity.agent}).`, "actor_mismatch", { taskId: args?.taskId ?? null });
      }
      const actor = identity.agent;
      const task = store.task.resumeGate({
        id: args?.taskId, actor, harness: identity.harness, session: identity.session,
      });
      if (!task) {
        // Name the common false alarm: the task was gated before but the gate
        // has since dissolved (e.g. an unmerged close requeued it).
        const current = args?.taskId ? store.task.get(args.taskId) : null;
        const lastGate = current && store.event.listFor(current.id).slice().reverse().find(
          (e) => typeof e.note === "string" && (e.note.startsWith("gate open:") || e.note === "gate resume")
        );
        if (lastGate && lastGate.note.startsWith("gate open:")) {
          return err(`backlog_resume: ${current.id} was gated but the gate has dissolved (status ${current.status}) — nothing to resume; re-gate with backlog_block if approval is still needed.`, "gate_dissolved", { taskId: current.id, taskStatus: current.status });
        }
        return err(`backlog_resume: not resumable: ${args?.taskId}`, "not_resumable", { taskId: args?.taskId ?? null });
      }
      logger?.info?.(`backlog: ${actor} resumed ${task.id}`);
      return ok(JSON.stringify({ ok: true, task: { id: task.id, status: task.status, gate_type: task.gate_type, assigned: task.assignee_agent } }), { status: "ok", taskId: task.id, actor });
    },
  };
}
