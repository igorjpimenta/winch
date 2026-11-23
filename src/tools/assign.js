// assign.js — route an item to an agent; the row is the wake.
//
// The tool still takes only `agent`. The harness is not a parameter: it is
// stamped from the caller's declared transport identity, so an assignment can
// never name an agent without saying which harness it belongs to. The reserved
// agent `human` gets the reserved harness `human_in_the_loop` instead.
import { ok, err } from "./shared.js";

export function createAssignTools({ store, logger }) {
  return {
    async backlog_assign(args, identity, cfg) {
      const qualified = `${identity.harness}:${identity.agent}`;
      const target = args?.id;
      const kind = target ? store.itemKindOf(target) : null;
      if (!kind) return err(`backlog_assign: not found: ${target}`, "not_found", { id: target ?? null });

      if (kind === "story") {
        const story = store.story.get(target);
        if (story.status === "done" || story.status === "cancelled") {
          return err(`${story.id} is ${story.status}; only live stories can be assigned.`, "rejected", { id: story.id });
        }
        if (args?.agent === null || args?.agent === "") {
          return err(`${story.id}: agent is required; null/unassigned is not allowed.`, "rejected", { id: story.id });
        }
        try {
          const assigned = args?.agent === undefined ? story.assignee_agent ?? null : (args.agent || null);
          const updated = store.story.update(story.id, {
            assigned,
            assigneeHarness: assigned ? identity.harness : null,
            capabilities: args?.capabilities !== undefined ? args.capabilities : story.capabilities ?? undefined,
          });
          store.event.append({
            itemId: story.id,
            fromStatus: story.status,
            toStatus: updated.status,
            kind: "story.assigned",
            actor: qualified,
            note: `assign ${assigned ?? "nobody"}`,
          });
          logger?.info?.(`backlog: ${qualified} assigned ${story.id} -> ${assigned ?? "nobody"}`);
          return ok(
            JSON.stringify({ ok: true, story: { id: updated.id, status: updated.status, assigned: updated.assignee_agent, capabilities: updated.capabilities } }),
            { status: "ok", level: "story", id: updated.id, assigned: updated.assignee_agent, agent: identity.agent }
          );
        } catch (e) {
          return err(`backlog_assign failed: ${e?.message}`, "rejected", { id: story.id });
        }
      }

      if (kind !== "task") {
        return err(`backlog_assign: ${target} is an ${kind}; assign a task or a story.`, "rejected", { id: target });
      }
      const task = store.task.get(target);
      if (args?.agent === null || args?.agent === "" || args?.agent === undefined) {
        return err(`${task.id}: agent is required; null/unassigned is not allowed.`, "rejected", { taskId: task.id });
      }
      try {
        const updated = store.task.assign({
          id: task.id,
          agentId: args?.agent ?? null,
          harness: identity.harness,
          actor: qualified,
          capabilities: args?.capabilities,
        });
        logger?.info?.(`backlog: ${qualified} assigned ${task.id} -> ${updated.assignee_agent ?? "nobody"}`);
        return ok(
          JSON.stringify({ ok: true, task: { id: updated.id, status: updated.status, assigned: updated.assignee_agent, capabilities: updated.capabilities } }),
          { status: "ok", taskId: updated.id, assigned: updated.assignee_agent, agent: identity.agent }
        );
      } catch (e) {
        return err(`backlog_assign failed: ${e?.message}`, "rejected", { taskId: task.id });
      }
    },
  };
}
