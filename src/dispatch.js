// Core dispatch: route lifecycle rows to wake admissions, then admit offers
// under per-harness and global caps. The harness accepts an offer; only the
// winner starts a session. Item status remains the work acknowledgement.

import { HUMAN_AGENT, HUMAN_HARNESS } from "./reserved.js";

const RELEASING_STATUSES = new Set(["done", "cancelled", "blocked", "backlog", "review"]);

function isHuman(agent, harness) {
  return agent === HUMAN_AGENT || harness === HUMAN_HARNESS;
}

function add(out, itemId, kind, agent, harness, reason) {
  if (!itemId || !agent || isHuman(agent, harness)) return;
  out.push({ itemId, kind, agentId: agent, harness: harness || "*", reason });
}

export function routesForEvent(ev, { planner = "" } = {}) {
  const out = [];
  const item = ev?.item;
  if (!item?.id) return out;
  const plannerSkip = (agent) => planner !== "" && agent === planner;

  const addTask = (agent, harness, reason) => {
    if (!agent || plannerSkip(agent)) return;
    add(out, item.id, "task", agent, harness, reason);
  };

  switch (ev.kind) {
    case "task.created":
    case "task.assigned":
    case "task.released":
    case "gate.resolved": {
      if (item.status !== "ready") break;
      addTask(item.assigned, item.assigneeHarness, ev.kind);
      break;
    }
    case "story.created":
    case "story.assigned": {
      if (item.status !== "ready") break;
      add(out, item.id, "story", item.assigned, item.assigneeHarness, ev.kind);
      break;
    }
    case "task.restored": {
      if (item.status !== "ready") break;
      addTask(item.assigned, item.assigneeHarness, ev.kind);
      break;
    }
    case "task.appended": {
      if (item.status !== "ready") break;
      const agent = ev.epicCreatedBy ?? item.createdBy;
      const harness = ev.epicAssigneeHarness ?? "*";
      add(out, ev.epicId ?? item.id, "append", agent, harness, ev.kind);
      break;
    }
    case "epic.completed": {
      if (item.kind !== "epic") break;
      const agent = ev.epicCreatedBy ?? item.createdBy;
      const harness = ev.epicAssigneeHarness ?? "*";
      add(out, item.id, "review", agent, harness, ev.kind);
      break;
    }
    default:
      break;
  }

  for (const u of ev?.unblocked ?? []) {
    addTask(u.assigned, u.assigneeHarness, "unblocked");
  }
  const seen = new Set();
  return out.filter((r) => {
    const key = `${r.itemId}\0${r.kind}\0${r.harness}\0${r.agentId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function observe(store, ev, at = Date.now()) {
  const item = ev?.item;
  if (item?.id) {
    const harness = item.assigneeHarness ?? ev.storyAssigneeHarness ?? ev.epicAssigneeHarness ?? "*";
    if (item.status === "in_progress") {
      store.admission.activate(item.id, harness, at);
    // `ready` is not generally releasing: assignment to ready is the wake.
    } else if (RELEASING_STATUSES.has(item.status) ||
               (item.status === "ready" && (ev.kind === "task.released" || ev.kind === "gate.resolved"))) {
      // A duplicate event must not release the row that event just admitted.
      store.admission.release(item.id, item.status, at, ev.id ?? null);
    }
  }
  const routes = routesForEvent(ev);
  for (const route of routes) {
    store.admission.enqueue({ ...route, eventId: ev.id ?? null, at });
  }
  return routes;
}

export function tick(store, { at = Date.now(), reachable = [], config = store.config } = {}) {
  store.admission.expire({
    at,
    offerMs: config.dispatchOfferMs,
    baseBackoffMs: config.dispatchOfferBackoffMs,
    maxBackoffMs: config.dispatchOfferMaxBackoffMs,
    maxAttempts: config.dispatchOfferMaxAttempts,
  });
  const offered = [];
  const harnesses = [...new Set(reachable)].filter(Boolean).sort();
  let globalUsed = store.admission.globalSlotCount();
  for (const harness of harnesses) {
    let harnessUsed = store.admission.slotCount(harness);
    for (const row of store.admission.queued(harness, at)) {
      if (harnessUsed >= config.dispatchHarnessMax || globalUsed >= config.dispatchGlobalMax) break;
      const next = store.admission.markOffered(row.id, at);
      if (!next) continue;
      store.admission.setParentCursor(next.item_id, at);
      offered.push(next);
      harnessUsed++;
      globalUsed++;
    }
  }
  return offered;
}
