// Core dispatch: route lifecycle rows to wake admissions, then admit offers
// under per-harness and global caps. The harness accepts an offer; only the
// winner starts a session. Item status remains the work acknowledgement.

import { HUMAN_AGENT, HUMAN_HARNESS } from "../reserved.js";
import { readyTasks } from "../ready-queue.js";
import { pickConsumer } from "./delivery.js";

const RELEASING_STATUSES = new Set(["done", "cancelled", "blocked", "backlog", "review"]);

function isHuman(agent, harness) {
  return agent === HUMAN_AGENT || harness === HUMAN_HARNESS;
}

function add(out, itemId, kind, agent, harness, reason) {
  if (!itemId || !agent || isHuman(agent, harness)) return;
  out.push({ itemId, kind, agentId: agent, harness: harness || "*", reason });
}

export function routesForEvent(ev) {
  const out = [];
  const item = ev?.item;
  if (!item?.id) return out;

  const addTask = (itemId, agent, harness, reason) => {
    if (!agent) return;
    add(out, itemId, "task", agent, harness, reason);
  };

  switch (ev.kind) {
    case "task.created":
    case "task.assigned":
    case "task.released":
    case "gate.resolved": {
      if (item.status !== "ready") break;
      addTask(item.id, item.assigned, item.assigneeHarness, ev.kind);
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
      addTask(item.id, item.assigned, item.assigneeHarness, ev.kind);
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
    addTask(u.id, u.assigned, u.assigneeHarness, "unblocked");
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


function trimOffers(store, harness, at, config) {
  const offered = store.admission.offers(harness)
    .map((row) => store.admission.get(row.id))
    .filter(Boolean)
    .sort((a, b) => (a.offered_at ?? 0) - (b.offered_at ?? 0)
      || (a.attempt_no ?? 0) - (b.attempt_no ?? 0)
      || String(a.id).localeCompare(String(b.id)));

  const { active, reserved } = store.admission.slots();
  const activeHarness = active.get(harness) ?? 0;
  const activeGlobal = [...active.values()].reduce((n, v) => n + v, 0);
  const reservedGlobal = [...reserved.values()].reduce((n, v) => n + v, 0);
  const otherReserved = Math.max(0, reservedGlobal - offered.length);
  const keep = Math.max(0, Math.min(
    config.dispatchHarnessMax - activeHarness,
    config.dispatchGlobalMax - activeGlobal - otherReserved,
    offered.length,
  ));
  const keptOffers = offered.slice(0, keep);
  for (const row of offered.slice(keep)) store.admission.requeue(row.id, at);
  return { offered, keptOffers, activeHarness, activeGlobal, otherReserved };
}

export function recover(store, { harness, consumerId = null, at = Date.now(), config = store.config, mutate = false } = {}) {
  if (mutate) store.admission.expire({
    at,
    offerMs: config.dispatchOfferMs,
    baseBackoffMs: config.dispatchOfferBackoffMs,
    maxBackoffMs: config.dispatchOfferMaxBackoffMs,
    maxAttempts: config.dispatchOfferMaxAttempts,
  });

  const resume = store.db.prepare(`
    SELECT s.item_id, s.assignee_agent, s.assignee_harness,
           a.id AS attempt_id, a.attempt_no, a.claimed_at, a.heartbeat_at, a.expires_at,
           a.lease_epoch, a.owner_instance,
           ws.id AS session_id, ws.external_session_id, ws.session_key,
           a.consumer_id AS consumer_id
      FROM item_state s
      LEFT JOIN attempts a ON a.item_id=s.item_id AND a.ended_at IS NULL
      LEFT JOIN work_sessions ws ON ws.id=a.session_id
     WHERE s.status='in_progress' AND s.deleted_at IS NULL AND s.assignee_harness=?
       AND (? IS NULL OR a.consumer_id = ?)
     ORDER BY a.claimed_at ASC, s.updated_at ASC
  `).all(harness, consumerId, consumerId).map((r) => ({
    task: store.task.get(r.item_id),
    attemptId: r.attempt_id ?? null,
    attemptNo: r.attempt_no ?? null,
    sessionId: r.session_id ?? null,
    sessionKey: r.session_key ?? null,
    leaseEpoch: r.lease_epoch ?? 0,
    ownerInstance: r.owner_instance ?? null,
    leaseExpiresAt: r.expires_at ?? null,
    consumerId: r.consumer_id ?? null,
    needsRepair: r.attempt_id == null,
  }));

  let offered, keptOffers, activeHarness, activeGlobal, otherReserved;
  if (mutate) {
    ({ offered, keptOffers, activeHarness, activeGlobal, otherReserved } = trimOffers(store, harness, at, config));
  } else {
    offered = store.admission.offers(harness)
      .map((row) => store.admission.get(row.id))
      .filter(Boolean)
      .sort((a, b) => (a.offered_at ?? 0) - (b.offered_at ?? 0)
        || (a.attempt_no ?? 0) - (b.attempt_no ?? 0)
        || String(a.id).localeCompare(String(b.id)));
    keptOffers = offered;
    const slots = store.admission.slots();
    activeHarness = slots.active.get(harness) ?? 0;
    activeGlobal = [...slots.active.values()].reduce((n, v) => n + v, 0);
    otherReserved = Math.max(0, [...slots.reserved.values()].reduce((n, v) => n + v, 0) - offered.length);
  }

  const settleAfter = at - (config.dispatchDeliveryLeaseMs ?? 300000);
  const wakeMax = config.dispatchWakeMax ?? 8;
  const running = store.delivery.runningAdmissionIds({ consumerId, after: settleAfter });
  const runningForConsumer = consumerId ? store.delivery.runningCount(consumerId, { after: settleAfter }) : 0;
  let windowFree = Math.max(0, wakeMax - runningForConsumer);

  const start = [];
  for (const live of keptOffers) {
    if (consumerId && live.active_consumer_id && live.active_consumer_id !== consumerId) continue;
    if (running.has(live.id)) continue;
    if (consumerId) {
      if (windowFree <= 0) continue;
      windowFree--;
    }
    start.push({
      admissionId: live.id,
      itemId: live.item_id,
      attemptNo: live.attempt_no ?? null,
      kind: live.kind,
      agent: live.agent_id,
      harness: live.harness,
      eventId: live.event_id ?? null,
      offerExpiresAt: (live.offered_at ?? at) + config.dispatchOfferMs,
      activeConsumerId: live.active_consumer_id ?? null,
      leaseEpoch: live.lease_epoch ?? 0,
      status: live.status,
    });
    // Handing a row over in this response starts its child: mark it running
    // so the pump does not post a second wake for it.
    if (mutate && consumerId) {
      store.delivery.markRunning({ admissionId: live.id, attemptNo: live.attempt_no ?? null, consumerId, at });
    }
  }

  const usedHarness = activeHarness + keptOffers.length;
  const usedGlobal = activeGlobal + otherReserved + keptOffers.length;
  let free = Math.max(0, Math.min(
    (config.dispatchHarnessMax ?? 8) - usedHarness,
    (config.dispatchGlobalMax ?? 16) - usedGlobal,
  ));
  if (mutate) for (const row of store.admission.queued(harness, at)) {
    if (free <= 0 || (consumerId && windowFree <= 0)) break;
    const next = store.admission.markOffered(row.id, at, {
      pickActive: (attemptNo) => pickConsumer(store, { ...row, attempt_no: attemptNo }),
      leaseMs: config.dispatchConsumerTtlMs,
    });
    if (!next) continue;
    start.push({
      admissionId: next.id,
      itemId: next.item_id,
      attemptNo: next.attempt_no ?? null,
      kind: next.kind,
      agent: next.agent_id,
      harness: next.harness,
      eventId: next.event_id ?? null,
      offerExpiresAt: at + config.dispatchOfferMs,
      activeConsumerId: next.active_consumer_id ?? null,
      leaseEpoch: next.lease_epoch ?? 0,
      status: "offered",
    });
    if (consumerId) {
      windowFree--;
      store.delivery.markRunning({ admissionId: next.id, attemptNo: next.attempt_no ?? null, consumerId, at });
    }
    free--;
  }

  // A ready task whose last admission expired is otherwise dormant: only a new
  // item event would enqueue it again. Recovery is the restart path, so it
  // re-admits ready assigned work for this harness within the same caps.
  if (mutate) for (const candidate of readyTasks(store, { harness, limit: free + 1 })) {
    if (free <= 0 || (consumerId && windowFree <= 0)) break;
    const agent = candidate.task.assignee_agent;
    if (!agent || isHuman(agent, candidate.task.assignee_harness)) continue;
    const busy = store.db.prepare(`
      SELECT 1 FROM admission_queue WHERE item_id=? AND harness=? AND ended_at IS NULL
    `).get(candidate.task.id, harness);
    if (busy) continue;
    const queued = store.admission.enqueue({ kind: "task", itemId: candidate.task.id, harness, agentId: agent, at });
    if (!queued) continue;
    const next = store.admission.markOffered(queued.id, at, {
      pickActive: (attemptNo) => pickConsumer(store, { ...queued, attempt_no: attemptNo }),
      leaseMs: config.dispatchConsumerTtlMs,
    });
    if (!next) continue;
    start.push({
      admissionId: next.id,
      itemId: next.item_id,
      attemptNo: next.attempt_no ?? null,
      kind: next.kind,
      agent: next.agent_id,
      harness: next.harness,
      eventId: next.event_id ?? null,
      offerExpiresAt: at + config.dispatchOfferMs,
      activeConsumerId: next.active_consumer_id ?? null,
      leaseEpoch: next.lease_epoch ?? 0,
      status: "offered",
    });
    if (consumerId) {
      windowFree--;
      store.delivery.markRunning({ admissionId: next.id, attemptNo: next.attempt_no ?? null, consumerId, at });
    }
    free--;
  }

  return { resume, start: consumerId ? start.filter((row) => row.activeConsumerId === consumerId) : start, free };
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
  for (const harness of harnesses) trimOffers(store, harness, at, config);
  let globalUsed = store.admission.globalSlotCount();
  for (const harness of harnesses) {
    let harnessUsed = store.admission.slotCount(harness);
    for (const row of store.admission.queued(harness, at)) {
      if (harnessUsed >= config.dispatchHarnessMax || globalUsed >= config.dispatchGlobalMax) break;
      const next = store.admission.markOffered(row.id, at, {
        pickActive: (attemptNo) => pickConsumer(store, { ...row, attempt_no: attemptNo }),
        leaseMs: config.dispatchConsumerTtlMs,
      });
      if (!next) continue;
      store.admission.setParentCursor(next.item_id, at);
      offered.push(next);
      harnessUsed++;
      globalUsed++;
    }
  }
  return offered;
}
