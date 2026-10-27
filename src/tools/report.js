// report.js — work reporting and gates: update, done, block, resume.
import { addDep } from "../deps.js";
import { identitySessionKey } from "../identity.js";
import { ok, err, clampNote } from "./shared.js";

export function createReportTools({ store, logger }) {
  return {
    async backlog_update(args, identity, cfg) {
      const agentId = identity.agent;
      const task = store.task.get(args?.taskId);
      if (!task) return err(`backlog_update: not found: ${args?.taskId}`, "not_found");
      if (task.status !== "in_progress") return err(`${task.id} is ${task.status}, not in_progress — claim it with backlog_claim first.`, "not_claimed", { taskId: task.id });
      if (task.assigned !== agentId) return err(`${task.id} is assigned to ${task.assigned}, not ${agentId}.`, "not_assignee", { taskId: task.id, assigned: task.assigned });
      try {
        const wantHeartbeat = args?.heartbeat !== false;
        if (wantHeartbeat) store.task.heartbeat(task.id, agentId);
        const noteParts = [];
        if (args?.progressSummary) noteParts.push(`progress: ${clampNote(args.progressSummary, cfg.noteProgressLimit)}`);
        if (args?.comment) noteParts.push(`comment: ${clampNote(args.comment, cfg.noteProgressLimit)}`);
        if (args?.addArtifact) noteParts.push(`artifact: ${clampNote(args.addArtifact, cfg.noteArtifactLimit)}`);
        if (noteParts.length) {
          // to_status is required by schema; progress events mirror the
          // current status so the event stream stays append-only without
          // fabricating a transition.
          store.db.prepare(
            "INSERT INTO events(task_id, from_status, to_status, actor, note, at) VALUES (?, ?, ?, ?, ?, ?)"
          ).run(task.id, task.status, task.status, agentId, noteParts.join(" | "), Date.now());
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
      if (task.assigned !== agentId) return err(`${task.id} is assigned to ${task.assigned}, not ${agentId}.`, "not_assignee", { taskId: task.id });
      try {
        const summary = clampNote(args.resultSummary, cfg.noteResultLimit);
        const artifacts = Array.isArray(args.artifacts) ? args.artifacts.slice(0, cfg.maxArtifacts) : [];
        const resultSummary = artifacts.length ? `${summary}\n\nartifacts: ${artifacts.join(", ")}` : summary;
        const updated = store.task.update(task.id, { status: "done", result_summary: resultSummary, actor: agentId, note: "done", sessionKey });
        // Close the loop at epic scope: the planner reviews what was delivered
        // rather than each task as it lands. One marker per epic, so a
        // dispatcher can wake on the row instead of counting on every close.
        const story = store.story.get(task.story_id);
        const epicId = story?.epic_id;
        if (epicId) {
          const open = store.db.prepare(
            "SELECT COUNT(*) AS n FROM tasks t JOIN stories s ON s.id=t.story_id WHERE s.epic_id=? AND t.status NOT IN ('done','cancelled')"
          ).get(epicId).n;
          const marked = store.db.prepare("SELECT 1 FROM events WHERE kind='epic.completed' AND note=?").get(epicId);
          if (open === 0 && !marked) {
            store.db.prepare("INSERT INTO events(task_id,from_status,to_status,kind,actor,note,at) VALUES(?,?,?,?,?,?,?)")
              .run(task.id, "done", "done", "epic.completed", `${identity.harness}:${identity.agent}`, epicId, Date.now());
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
      if (task.assigned && task.assigned !== agentId) return err(`${task.id} is assigned to ${task.assigned}, not ${agentId}.`, "not_assignee", { taskId: task.id });
      if (task.status !== "in_progress" && task.status !== "todo") return err(`${task.id} is ${task.status}; blocking applies to todo/in_progress only.`, "wrong_status", { taskId: task.id });
      try {
        const reason = clampNote(args.reason, cfg.noteReasonLimit);
        let updated;
        if (args?.gateType) {
          // Human gates open through openGate — the one path that stamps
          // gate.opened rows — never the generic update. Plain blocks keep
          // the generic path and its task.blocked kind.
          updated = store.task.openGate({ id: task.id, gateType: args.gateType, reason, actor: agentId });
          if (!updated) return err(`${task.id} is ${store.task.get(task.id)?.status ?? "gone"}; gating applies to todo/in_progress only.`, "wrong_status", { taskId: task.id });
        } else {
          updated = store.task.update(task.id, { status: "blocked", actor: agentId, note: `blocked: ${reason}` });
        }
        let depResult = null;
        if (args?.blockedBy) {
          const r = addDep(store, task.id, args.blockedBy.id);
          depResult = r.ok ? "added" : `failed:${r.code}`;
          if (r.ok) {
            store.db.prepare(
              "INSERT INTO events(task_id, from_status, to_status, actor, note, at) VALUES (?, ?, ?, ?, ?, ?)"
            ).run(task.id, "blocked", "blocked", agentId, `dep: ${task.id} depends on ${args.blockedBy.id}`, Date.now());
          }
        }
        logger?.warn?.(`backlog: ${agentId} blocked ${task.id} (${reason})`);
        return ok(JSON.stringify({ ok: true, task: { id: updated.id, status: updated.status }, dep: depResult }), { status: "ok", taskId: task.id, agentId, dep: depResult });
      } catch (e) {
        return err(`backlog_block failed: ${e?.message}`, "error");
      }
    },

    async backlog_resume(args, identity, cfg) {
      // The actor is the caller, never the caller's claim about who acts: a
      // mismatched actor would mint another key's approval on the trail, so
      // the call fails instead. Humans approve through `winch resume --actor`
      // on stdin trust; over MCP there is no speaking for another key.
      if (args?.actor != null && args.actor !== identity.agent) {
        return err(`backlog_resume: refused actor ${JSON.stringify(args.actor)} — approvals record the caller (${identity.agent}).`, "actor_mismatch", { taskId: args?.taskId ?? null });
      }
      const actor = identity.agent;
      const task = store.task.resumeGate({ id: args?.taskId, actor });
      if (!task) {
        // Name the common false alarm: the task was gated before (a gate
        // note sits in its trail) but the gate has since dissolved — e.g. an
        // unmerged close requeued it. The operator approved something real;
        // "not resumable" alone would read as operator error. A trailing
        // 'gate resume' is the opposite case (already resolved), so only an
        // opened-but-never-resolved gate dissolves.
        const current = args?.taskId ? store.task.get(args.taskId) : null;
        const lastGate = current && store.db.prepare(
          "SELECT note FROM events WHERE task_id=? AND (note LIKE 'gate open:%' OR note='gate resume') ORDER BY id DESC LIMIT 1"
        ).get(current.id);
        if (lastGate && lastGate.note.startsWith("gate open:")) return err(`backlog_resume: ${current.id} was gated but the gate has dissolved (status ${current.status}) — nothing to resume; re-gate with backlog_block if approval is still needed.`, "gate_dissolved", { taskId: current.id, taskStatus: current.status });
        return err(`backlog_resume: not resumable: ${args?.taskId}`, "not_resumable", { taskId: args?.taskId ?? null });
      }
      logger?.info?.(`backlog: ${actor} resumed ${task.id}`);
      return ok(JSON.stringify({ ok: true, task: { id: task.id, status: task.status, gate_type: task.gate_type, assigned: task.assigned } }), { status: "ok", taskId: task.id, actor });
    },
  };
}
