// ready-queue.js — compute "what's ready to work on" for a given agent.
//
// A task is *ready* iff:
//   - status = 'todo'
//   - all of its outgoing deps resolve to status in {done, cancelled}
//   - nearest story status in {ready, in_progress}
//   - nearest epic  status in {planned, in_progress}
//   - (when agentId is supplied) unassigned, or assigned to the same pair
//   - (when capabilities supplied) intersection with task/story tags is non-empty
//
// Ordering: priority DESC (cascading story/epic priority on tie),
//           then created_at ASC.

import { depsResolved } from "./deps.js";

function effectiveCaps(task, story) {
  if (Array.isArray(task.capabilities) && task.capabilities.length > 0) return task.capabilities;
  if (Array.isArray(story?.capabilities) && story.capabilities.length > 0) return story.capabilities;
  return [];
}

function capMatch(required, offered) {
  if (!required || required.length === 0) return true; // no requirement = open
  if (!offered || offered.length === 0) return false;
  return required.some((r) => offered.includes(r));
}

/**
 * Return ready tasks, ordered by composite priority.
 *
 * @param {{agentId?: string, harness?: string, capabilities?: string[], limit?: number}} opts
 */
export function readyTasks(store, opts = {}) {
  const { agentId, harness, capabilities, limit, ignoreCapabilities = false } = opts;
  const candidates = store.item.list({ kind: "task", status: "todo" });
  const ready = [];
  for (const task of candidates) {
    const story = task.story_id ? store.item.get(task.story_id) : null;
    if (!story) continue;
    if (story.status !== "ready" && story.status !== "in_progress") continue;
    const epic = task.epic_id ? store.item.get(task.epic_id) : null;
    if (!epic) continue;
    if (epic.status !== "planned" && epic.status !== "in_progress") continue;
    if (task.assignee_agent && agentId) {
      if (task.assignee_agent !== agentId) continue;
      // Legacy assignments carry the wildcard harness; new ones name it.
      if (harness && task.assignee_harness && task.assignee_harness !== "legacy" && task.assignee_harness !== harness) continue;
    }
    const required = effectiveCaps(task, story);
    if (!ignoreCapabilities && !capMatch(required, capabilities)) continue;
    if (!depsResolved(store, task.id)) continue;
    if (!depsResolved(store, story.id)) continue;
    if (!depsResolved(store, epic.id)) continue;
    ready.push({
      task,
      story,
      epic,
      composite: [task.assignee_agent === agentId ? 1 : 0, story.priority, epic.priority, -task.created_at],
    });
  }
  ready.sort((a, b) => {
    for (let i = 0; i < a.composite.length; i++) {
      if (a.composite[i] !== b.composite[i]) return b.composite[i] - a.composite[i];
    }
    return 0;
  });
  return (limit && limit > 0) ? ready.slice(0, limit) : ready;
}

/**
 * Return the single next-best ready task for an agent, or null. Read-only.
 */
export function nextReadyTask(store, opts = {}) {
  const list = readyTasks(store, { ...opts, limit: 1 });
  return list[0] ?? null;
}
