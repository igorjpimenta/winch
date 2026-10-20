// ready-queue.js — compute "what's ready to work on" for a given agent.
//
// A task is *ready* iff:
//   - status = 'todo'
//   - all of its outgoing deps resolve to status in {done, cancelled}
//   - parent story status in {ready, in_progress}
//   - parent epic  status in {planned, in_progress}
//   - (when agentId is supplied) assigned IS NULL OR assigned = agentId
//   - (when capabilities supplied) intersection with task/story caps is non-empty
//
// Ordering: priority DESC (cascading story/epic priority on tie),
//           then created_at ASC.

import { depsResolved } from "./deps.js";

function effectiveCaps(task, story) {
  if (Array.isArray(task.capabilities) && task.capabilities.length > 0) return task.capabilities;
  if (Array.isArray(story.capabilities) && story.capabilities.length > 0) return story.capabilities;
  return [];
}

function capMatch(required, offered) {
  if (!required || required.length === 0) return true; // no requirement = open
  if (!offered  || offered.length  === 0) return false;
  return required.some((r) => offered.includes(r));
}

/**
 * Return ready tasks, ordered by composite priority.
 *
 * @param {{agentId?: string, capabilities?: string[], limit?: number}} opts
 */
export function readyTasks(store, opts = {}) {
  const { agentId, capabilities, limit } = opts;
  const candidates = store.task.list({ status: "todo" });
  const ready = [];
  for (const task of candidates) {
    const story = store.story.get(task.story_id);
    if (!story) continue;
    if (story.status !== "ready" && story.status !== "in_progress") continue;
    const epic = store.epic.get(story.epic_id);
    if (!epic) continue;
    if (epic.status !== "planned" && epic.status !== "in_progress") continue;
    if (task.assigned && agentId && task.assigned !== agentId) continue;
    const required = effectiveCaps(task, story);
    if (!capMatch(required, capabilities)) continue;
    if (!depsResolved(store, task.id)) continue;
    if (!depsResolved(store, story.id)) continue;
    if (!depsResolved(store, epic.id))  continue;
    ready.push({
      task,
      story,
      epic,
      composite: [task.assigned === agentId ? 1 : 0, story.priority, epic.priority, -task.created_at],
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
