// read.js — one read tool, any level: epic, story or task. Level comes from
// the row's `kind`, never from the id shape.
import { depsResolved } from "../deps.js";
import { ok, err, collectStoryArtifacts, renderReceiverPrompt } from "./shared.js";

export function createReadTools({ store, logger }) {
  const taskView = (t) => ({
    id: t.id,
    title: t.title,
    description: t.description ?? null,
    status: t.status,
    assigned: t.assignee_agent ?? null,
    capabilities: t.capabilities?.length ? t.capabilities : null,
    result_summary: t.result_summary ?? null,
    artifacts: store.artifact.listFor(t.id).map((a) => a.uri),
  });

  return {
    async backlog_get(args, identity, cfg) {
      const id = args?.id;
      if (!id) return err("backlog_get: id is required", "rejected");
      try {
        const kind = store.itemKindOf(id);
        if (!kind) return err(`backlog_get: not found: ${id}`, "not_found");

        if (kind === "epic") {
          const epic = store.epic.get(id);
          const stories = store.item.list({ kind: "story", parentId: epic.id }).map((s) => ({
            id: s.id, title: s.title, description: s.description ?? null, acceptance: s.acceptance ?? null,
            status: s.status, priority: s.priority,
            tasks: store.item.tree(s.id).filter((r) => r.kind === "task").map(taskView),
          }));
          const all = stories.flatMap((s) => s.tasks);
          const count = (st) => all.filter((t) => t.status === st).length;
          return ok(
            JSON.stringify({
              level: "epic",
              epic: { id: epic.id, title: epic.title, description: epic.description, acceptance: epic.acceptance, status: epic.status, priority: epic.priority },
              stories,
              summary: { tasks: all.length, done: count("done"), todo: count("todo"), in_progress: count("in_progress"), blocked: count("blocked"), cancelled: count("cancelled") },
            }),
            { status: "ok", agentId: identity.agent, level: "epic", id: epic.id }
          );
        }

        if (kind === "story") {
          const story = store.story.get(id);
          const epic = story.epic_id ? store.epic.get(story.epic_id) : null;
          return ok(
            JSON.stringify({
              level: "story",
              story: { id: story.id, title: story.title, description: story.description, acceptance: story.acceptance, status: story.status, priority: story.priority },
              epic: epic ? { id: epic.id, title: epic.title, acceptance: epic.acceptance, status: epic.status } : null,
              tasks: store.item.tree(story.id).filter((r) => r.kind === "task").map(taskView),
              artifacts: collectStoryArtifacts(store, story.id),
            }),
            { status: "ok", agentId: identity.agent, level: "story", id: story.id }
          );
        }

        const task = store.task.get(id);
        const story = task.story_id ? store.story.get(task.story_id) : null;
        const epic = task.epic_id ? store.epic.get(task.epic_id) : null;
        const artifacts = story ? collectStoryArtifacts(store, story.id) : [];
        const requiredCaps = Array.isArray(task.capabilities) && task.capabilities.length > 0
          ? task.capabilities
          : Array.isArray(story?.capabilities) && story.capabilities.length > 0 ? story.capabilities : [];
        const offered = Array.isArray(args?.capabilities) ? args.capabilities : [];
        const deps = store.dep.listOutgoing(task.id).map((e) => {
          const item = store.item.get(e.to_id);
          return { kind: e.to_kind, id: e.to_id, status: item?.status ?? null };
        });
        const blockers = [];
        if (task.status !== "todo") blockers.push(`task is ${task.status}`);
        if (!story) blockers.push("story missing");
        else if (story.status !== "ready" && story.status !== "in_progress") blockers.push(`story is ${story.status}`);
        if (!epic) blockers.push("epic missing");
        else if (epic.status !== "planned" && epic.status !== "in_progress") blockers.push(`epic is ${epic.status}`);
        if (!depsResolved(store, task.id)) blockers.push("task dependencies unresolved");
        if (task.assignee_agent && task.assignee_agent !== identity.agent) blockers.push(`assigned to ${task.assignee_agent}`);
        if (offered.length > 0 && requiredCaps.length > 0 && !offered.some((c) => requiredCaps.includes(c))) {
          blockers.push(`requires [${requiredCaps.join(", ")}]`);
        }
        return ok(
          JSON.stringify({
            level: "task",
            task,
            story: story ? { id: story.id, title: story.title, description: story.description, acceptance: story.acceptance, status: story.status, priority: story.priority } : null,
            epic: epic ? { id: epic.id, title: epic.title, description: epic.description, acceptance: epic.acceptance, status: epic.status, priority: epic.priority } : null,
            artifacts,
            dependencies: deps,
            readiness: { ready: blockers.length === 0, blockers, requiresCapabilities: requiredCaps, assignedTo: task.assignee_agent ?? null },
            recentEvents: store.event.listFor(task.id).slice(-10).map((e) => ({ id: e.id, kind: e.kind, actor: e.actor, note: e.note, at: e.created_at })).reverse(),
            brief: story ? renderReceiverPrompt({ task, story, epic, artifacts }) : null,
          }),
          { status: "ok", agentId: identity.agent, level: "task", id: task.id }
        );
      } catch (e) {
        logger?.warn?.(`backlog_get failed: ${e?.message}`);
        return err(`backlog_get failed: ${e?.message}`, "error");
      }
    },
  };
}
