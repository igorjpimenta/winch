// read.js — one read tool, any level: epic, story or task.
import { depsResolved } from "../deps.js";
import { ok, err, collectStoryArtifacts, renderReceiverPrompt } from "./shared.js";

export function createReadTools({ store, logger }) {
  // One shape for a task inside a tree, so epic and story views agree.
  const taskView = (t) => ({
    id: t.id,
    title: t.title,
    description: t.description ?? null,
    status: t.status,
    assigned: t.assigned ?? null,
    capabilities: t.capabilities ?? null,
    result_summary: t.result_summary ?? null,
    artifacts: store.db.prepare("SELECT note FROM events WHERE task_id=? AND note LIKE 'artifact:%'").all(t.id)
      .map((e) => e.note.slice("artifact: ".length).trim()),
  });

  return {
    async backlog_get(args, identity, cfg) {
      const id = args?.id;
      if (!id) return err("backlog_get: id is required", "rejected");
      try {
        if (id.startsWith("EPIC-")) {
          const epic = store.epic.get(id);
          if (!epic) return err(`backlog_get: not found: ${id}`, "not_found");
          const stories = store.story.list({ epicId: epic.id }).map((s) => ({
            id: s.id, title: s.title, description: s.description ?? null, acceptance: s.acceptance ?? null,
            status: s.status, priority: s.priority,
            tasks: store.task.list({ storyId: s.id }).map(taskView),
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
        if (id.startsWith("STORY-")) {
          const story = store.story.get(id);
          if (!story) return err(`backlog_get: not found: ${id}`, "not_found");
          const epic = store.epic.get(story.epic_id);
          return ok(
            JSON.stringify({
              level: "story",
              story: { id: story.id, title: story.title, description: story.description, acceptance: story.acceptance, status: story.status, priority: story.priority },
              epic: epic ? { id: epic.id, title: epic.title, acceptance: epic.acceptance, status: epic.status } : null,
              tasks: store.task.list({ storyId: story.id }).map(taskView),
              artifacts: collectStoryArtifacts(store, story.id),
            }),
            { status: "ok", agentId: identity.agent, level: "story", id: story.id }
          );
        }
        const task = store.task.get(id);
        if (!task) return err(`backlog_get: not found: ${id}`, "not_found");
        const story = store.story.get(task.story_id);
        const epic = story ? store.epic.get(story.epic_id) : null;
        const artifacts = story ? collectStoryArtifacts(store, story.id) : [];
        const requiredCaps = Array.isArray(task.capabilities) && task.capabilities.length > 0
          ? task.capabilities
          : Array.isArray(story?.capabilities) && story.capabilities.length > 0 ? story.capabilities : [];
        const offered = Array.isArray(args?.capabilities) ? args.capabilities : [];
        const deps = store.dep.listOutgoing(task.id).map((e) => {
          const item = ({ epic: store.epic.get, story: store.story.get, task: store.task.get })[e.to_kind](e.to_id);
          return { kind: e.to_kind, id: e.to_id, status: item?.status ?? null };
        });
        // Readiness mirrors ready-queue.js so a worker can tell "not mine" from
        // "not yet" without guessing; the read itself is never filtered.
        const blockers = [];
        if (task.status !== "todo") blockers.push(`task is ${task.status}`);
        if (!story) blockers.push("story missing");
        else if (story.status !== "ready" && story.status !== "in_progress") blockers.push(`story is ${story.status}`);
        if (!epic) blockers.push("epic missing");
        else if (epic.status !== "planned" && epic.status !== "in_progress") blockers.push(`epic is ${epic.status}`);
        if (!depsResolved(store, task.id)) blockers.push("task dependencies unresolved");
        if (task.assigned && task.assigned !== identity.agent) blockers.push(`assigned to ${task.assigned}`);
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
            readiness: { ready: blockers.length === 0, blockers, requiresCapabilities: requiredCaps, assignedTo: task.assigned ?? null },
            recentEvents: store.db.prepare("SELECT id, kind, actor, note, at FROM events WHERE task_id=? ORDER BY id DESC LIMIT 10").all(task.id),
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
