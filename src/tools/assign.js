// assign.js — route a task or a story to an agent; the row is the wake.
import { ok, err } from "./shared.js";

export function createAssignTools({ store, logger }) {
  return {
    async backlog_assign(args, identity, cfg) {
      // Like every other tool: availability is the host's tool policy, and
      // the caller is attributed by identity. No server-side allowlist.
      const qualified = `${identity.harness}:${identity.agent}`;
      const target = args?.id ?? args?.taskId;
      if (target && target.startsWith("STORY-")) {
        const story = store.story.get(target);
        if (!story) return err(`backlog_assign: not found: ${target}`, "not_found", { id: target });
        if (story.status === "done" || story.status === "cancelled") {
          return err(`${story.id} is ${story.status}; only live stories can be assigned.`, "rejected", { id: story.id });
        }
        try {
          const assigned = args?.agent === undefined ? story.assigned ?? null : (args.agent || null);
          const updated = store.story.update(story.id, {
            assigned,
            capabilities: args?.capabilities !== undefined ? args.capabilities : story.capabilities ?? undefined,
          });
          // Story-scoped audit row: task_id carries the item id, item_kind
          // says which level, so a dispatcher can wake the owner to break the
          // story into tasks.
          store.db.prepare("INSERT INTO events(task_id,item_kind,from_status,to_status,kind,actor,note,at) VALUES(?,?,?,?,?,?,?,?)")
            .run(story.id, "story", story.status, updated.status, "story.assigned", qualified,
              `assign ${assigned ?? "nobody"}`, Date.now());
          logger?.info?.(`backlog: ${qualified} assigned ${story.id} -> ${assigned ?? "nobody"}`);
          return ok(
            JSON.stringify({ ok: true, story: { id: updated.id, status: updated.status, assigned: updated.assigned, capabilities: updated.capabilities } }),
            { status: "ok", level: "story", id: updated.id, assigned: updated.assigned, agent: identity.agent }
          );
        } catch (e) {
          return err(`backlog_assign failed: ${e?.message}`, "rejected", { id: story.id });
        }
      }
      const task = store.task.get(target);
      if (!task) return err(`backlog_assign: not found: ${target}`, "not_found", { taskId: target ?? null });
      try {
        const updated = store.task.assign({
          id: task.id,
          agentId: args?.agent ?? null,
          actor: qualified,
          capabilities: args?.capabilities,
        });
        logger?.info?.(`backlog: ${qualified} assigned ${task.id} -> ${updated.assigned ?? "nobody"}`);
        return ok(
          JSON.stringify({ ok: true, task: { id: updated.id, status: updated.status, assigned: updated.assigned, capabilities: updated.capabilities } }),
          { status: "ok", taskId: updated.id, assigned: updated.assigned, agent: identity.agent }
        );
      } catch (e) {
        return err(`backlog_assign failed: ${e?.message}`, "rejected", { taskId: task.id });
      }
    },
  };
}
