// delegate.js — hand work to another worker without changing the parent's
// accountable assignee. The child is the worker's item; the parent stays with
// the accountable and waits on the child.
import { addDep } from "../deps.js";
import { HUMAN_AGENT, HUMAN_HARNESS } from "../reserved.js";
import { clampNote, err, ok } from "./shared.js";

export function createDelegateTools({ store, logger }) {
  return {
    async backlog_delegate(args, identity, cfg) {
      const parentId = args?.taskId ?? args?.id;
      if (!parentId) return err("backlog_delegate: taskId is required", "rejected");
      const parent = store.task.get(parentId);
      if (!parent) return err(`backlog_delegate: task not found: ${parentId}`, "not_found");

      const worker = args?.agent;
      if (worker === null || worker === "" || worker === undefined) {
        return err("backlog_delegate: agent is required", "rejected", { taskId: parent.id });
      }
      const childKey = args?.childKey == null || args.childKey === "" ? null : String(args.childKey);
      const visitSeq = args?.visitSeq == null ? 0 : Number(args.visitSeq);
      if (!Number.isInteger(visitSeq) || visitSeq < 0) {
        return err("backlog_delegate: visitSeq must be a non-negative integer", "rejected", { taskId: parent.id });
      }
      if (parent.assignee_agent && parent.assignee_agent !== identity.agent) {
        return err(
          `${parent.id} is assigned to ${parent.assignee_agent}, not ${identity.agent}; only the accountable can delegate it.`,
          "not_assignee",
          { taskId: parent.id, assigned: parent.assignee_agent }
        );
      }

      const actor = `${identity.harness}:${identity.agent}`;
      const depWait = parent.status === "blocked" && parent.state_json?.wait?.kind === "deps";

      // A retry of the same (parent, childKey, visitSeq) is a lookup, not a
      // second delegation. Do it before the blocked check: the first attempt
      // parked the parent.
      if (childKey) {
        const existing = store.item.byChild(parent.id, childKey, visitSeq);
        if (existing) {
          addDep(store, parent.id, existing.id);
          if (!["blocked", "done", "cancelled", "review"].includes(parent.status) &&
              existing.status !== "done" && existing.status !== "cancelled") {
            store.task.blockOnDeps({
              id: parent.id,
              note: `delegated ${existing.id} to ${existing.assignee_agent ?? worker}`,
              childId: existing.id,
              actor,
            });
          }
          const freshParent = store.task.get(parent.id);
          return ok(
            JSON.stringify({
              ok: true,
              reused: true,
              parent: { id: freshParent.id, status: freshParent.status, assigned: freshParent.assignee_agent },
              child: { id: existing.id, status: existing.status, assigned: existing.assignee_agent, childKey, visitSeq },
            }),
            { status: "ok", taskId: parent.id, childId: existing.id, agent: identity.agent, reused: true }
          );
        }
      }

      if (parent.status === "done" || parent.status === "cancelled") {
        return err(`${parent.id} is ${parent.status}; only live tasks can delegate.`, "rejected", { taskId: parent.id });
      }
      if (parent.status === "blocked" && !depWait) {
        return err(`${parent.id} is already blocked; resolve or close its current wait before delegating again.`, "rejected", { taskId: parent.id });
      }
      if (parent.status === "review") {
        return err(`${parent.id} is in review; accept or return it before delegating.`, "rejected", { taskId: parent.id });
      }
      if (!args?.title) return err("backlog_delegate: title is required", "rejected", { taskId: parent.id });

      if (!parent.assignee_agent) {
        store.task.assign({ id: parent.id, agentId: identity.agent, harness: identity.harness, actor });
      }

      let parentSession = null;
      if (identity.session) {
        parentSession = store.session.ensure({
          harness: identity.harness,
          agentId: identity.agent,
          externalSessionId: identity.session,
          itemId: parent.id,
          kind: "claim",
        });
      }

      let child;
      try {
        child = store.task.create({
          storyId: parent.id,
          title: args.title,
          description: args.description ?? null,
          acceptance: args.acceptance ?? parent.acceptance ?? null,
          status: "backlog",
          executionKind: args.executionKind ?? "manual",
          executionArgs: args.executionArgs,
          capabilities: args.capabilities ?? parent.capabilities,
          assigned: worker,
          assigneeHarness: worker === HUMAN_AGENT ? HUMAN_HARNESS : identity.harness,
          childKey,
          visitSeq,
          state: parentSession ? { fanout: { parentSessionId: parentSession.id } } : undefined,
        });
      } catch (e) {
        return err(`backlog_delegate failed: ${e?.message}`, "error", { taskId: parent.id });
      }

      const edge = addDep(store, parent.id, child.id);
      if (!edge.ok) {
        try { store.item.drop(child.id, { reason: "delegate failed", actor }); } catch { /* best effort */ }
        return err(`backlog_delegate: dependency rejected: ${edge.code}`, "error", { taskId: parent.id });
      }

      try {
        const reason = args?.reason == null ? null : clampNote(args.reason, cfg.noteReasonLimit);
        const note = reason
          ? `delegated ${child.id} to ${worker}: ${reason}`
          : `delegated ${child.id} to ${worker}`;
        if (depWait) {
          store.event.append({
            itemId: parent.id, fromStatus: "blocked", toStatus: "blocked", kind: "deps.waiting",
            actor, note: `waiting on ${child.id}`,
          });
        } else {
          store.task.blockOnDeps({ id: parent.id, note, childId: child.id, actor });
        }
        logger?.info?.(`backlog: ${actor} delegated ${parent.id} -> ${child.id} (${worker})`);
        const fresh = store.task.get(parent.id);
        return ok(
          JSON.stringify({
            ok: true,
            parent: { id: fresh.id, status: fresh.status, assigned: fresh.assignee_agent },
            child: { id: child.id, status: child.status, assigned: child.assignee_agent, childKey, visitSeq },
          }),
          { status: "ok", taskId: parent.id, childId: child.id, agent: identity.agent }
        );
      } catch (e) {
        try { store.item.drop(child.id, { reason: "delegate failed", actor }); } catch { /* best effort */ }
        return err(`backlog_delegate failed: ${e?.message}`, "error", { taskId: parent.id });
      }
    },
  };
}
