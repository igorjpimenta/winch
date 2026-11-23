// events.js — the event envelope: stored transition rows in, subscriber
// envelopes out. No socket here. Webhook wakes are the main event driver
// (dispatch-webhook.js via dispatch-server.js); the store write hook and the
// dispatch boot catch-up share this one shape.
//
// kindForEvent: stable kind for a stored transition. Structural inference
// covers task.* (created, claimed, progressed, completed, released, blocked,
// cancelled, updated) and gate.* (opened, resolved, dissolved); producers may
// store story.*, deps.* and release.*. A stored `kind` wins; otherwise the row
// maps by transition structure alone. Notes are free text and can change, so
// no branch here may read note content — a renamed note must never
// reclassify history.
//
// Pre-standardization rows still carry `todo` as a task status; map it with
// `ready` so the append-only history keeps the meaning it streamed with.

import { collectStoryArtifacts } from "./tools/index.js";
import { depsResolved } from "./deps.js";
import { HUMAN_AGENT } from "./reserved.js";

export const HISTORY_LIMIT = 200;

export function lastEventId(store) {
  return store.event.lastEventId();
}

export function eventsSince(store, id, limit = HISTORY_LIMIT) {
  return store.event.since(id, limit);
}

export function eventsLatest(store, limit = HISTORY_LIMIT) {
  return store.event.latest(limit);
}

export function kindForEvent(row) {
  if (row.kind) return row.kind;
  const from = row.from_status;
  const to = row.to_status;
  if (from == null) return "task.created";
  if ((from === "ready" || from === "todo") && to === "in_progress") return "task.claimed";
  if (from === "in_progress" && to === "in_progress") return "task.progressed";
  if (to === "done") return "task.completed";
  if (to === "cancelled") return "task.cancelled";
  if (to === "blocked") return "task.blocked";
  if (to === "ready" || to === "todo") return "task.released";
  return "task.updated";
}

// One envelope shape for history and live rows alike: the stored transition
// plus the task, story and epic context a subscriber would otherwise fetch
// once per row. Artifacts come from the same collector the claim handoff
// uses, so both paths agree on what "the artifacts" means.
function unblockedFor(store, row, kind) {
  const terminal = row.to_status === "done" || row.to_status === "cancelled";
  const claims = terminal
    || kind === "task.released" || kind === "task.appended"
    || kind === "deps.resolved" || kind === "gate.resolved";
  if (!claims) return [];

  const ids = new Set();
  if (terminal) {
    for (const edge of store.dep.listIncoming(row.item_id)) ids.add(edge.from_id);
  } else if (row.item_id) {
    ids.add(row.item_id);
  }

  const out = [];
  for (const id of ids) {
    const task = store.task.get(id);
    if (!task || task.status !== "ready" || !task.assignee_agent || task.assignee_agent === HUMAN_AGENT) continue;
    if (!depsResolved(store, id)) continue;
    out.push({ id: task.id, assigned: task.assignee_agent, assigneeHarness: task.assignee_harness });
    if (out.length === 20) break;
  }
  return out;
}

export function toEventMessage(store, row, { includeArtifacts = true, includeUnblocked = true } = {}) {
  const kind = kindForEvent(row);
  const item = !row.item_id ? null : store.item.get(row.item_id);
  const itemKind = item?.kind ?? null;
  const task = itemKind === "task" ? item : null;
  const story = itemKind === "story" ? item : task?.story_id ? store.story.get(task.story_id) : null;
  const epic = itemKind === "epic" ? item : story?.epic_id ? store.epic.get(story.epic_id) : item?.epic_id ? store.epic.get(item.epic_id) : null;
  const actorSession = row.session_id ? store.session.get(row.session_id) : null;
  return {
    type: "event",
    kind,
    id: row.id,
    at: row.created_at,
    fromStatus: row.from_status ?? null,
    toStatus: row.to_status,
    // Normalised item: a dispatcher routes assignment and review wakes without
    // knowing which level the row is about.
    item: item
      ? {
          id: item.id,
          kind: itemKind,
          title: item.title,
          status: item.status,
          assigned: item.assignee_agent ?? null,
          assigneeHarness: item.assignee_harness ?? null,
          createdBy: item.created_by ?? null,
        }
      : null,
    epicId: epic?.id ?? null,
    epicCreatedBy: epic?.created_by ?? null,
    epicAssigneeHarness: epic?.assignee_harness ?? null,
    storyId: story?.id ?? null,
    storyAssigned: story?.assignee_agent ?? null,
    storyAssigneeHarness: story?.assignee_harness ?? null,
    // Work a transition just made claimable: a dispatcher wakes these without
    // recomputing the dependency graph. Creation and direct assignment already
    // route their own item, so only a close looks at incoming edges.
    unblocked: includeUnblocked ? unblockedFor(store, row, kind) : [],
    task: task
      ? {
          id: task.id,
          title: task.title,
          story: story ? story.title : null,
          epic: epic ? epic.title : null,
          acceptance: story ? story.acceptance : null,
          artifacts: includeArtifacts && story ? collectStoryArtifacts(store, story.id) : [],
          assignee: task.assignee_agent,
        }
      : null,
    actor: row.actor,
    actorHarness: actorSession?.harness ?? null,
    note: row.note,
  };
}
