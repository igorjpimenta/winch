// store/index.js — data layer over better-sqlite3.
//
// One recursive `items` table holds epics, stories and tasks; `item_state`
// carries the mutable half, `attempts` one row per claim, `work_sessions` the
// actor, `item_events` the append-only ledger. The `epic`/`story`/`task`
// facades preserve the tool-facing method names on top of that model.
//
// Concurrency: WAL mode enabled. CLI and gateway processes can read/write the
// same DB concurrently; sqlite serializes the writes. Every multi-row
// transition (claim + attempt + event, gate + event, drop) runs inside one
// BEGIN IMMEDIATE transaction.

import { resolveConfig } from "../config.js";
import { resolveDbPath } from "../paths.js";
import { openDatabase } from "../db.js";
import {
  EPIC_STATUSES,
  STORY_STATUSES,
  TASK_STATUSES,
  EXECUTION_KINDS,
  ITEM_KINDS,
} from "../schema.js";
import { createCore, jsonIn, MAX_ATTEMPTS } from "./core.js";
import { createItemApi } from "./items.js";
import { createAttemptApi } from "./attempts.js";
import { createArtifactApi } from "./artifacts.js";
import { createEpicApi } from "./epics.js";
import { createStoryApi } from "./stories.js";
import { createTaskApi } from "./tasks.js";
import { createClaimMethods } from "./claims.js";
import { createGateMethods } from "./gates.js";
import { createSweepMethods } from "./sweep.js";
import { createDepApi } from "./deps.js";
import { createWebhookApi } from "./webhook.js";
import { createEventApi } from "./events.js";
import { createAdmissionApi } from "./admission.js";
import { createDeliveryApi } from "./delivery.js";
import { createDispatchEventApi } from "./dispatch-events.js";
import { observe } from "../dispatch.js";
import { toEventMessage } from "../events-ws.js";

export { MAX_ATTEMPTS };
export { EPIC_STATUSES, STORY_STATUSES, TASK_STATUSES, EXECUTION_KINDS, ITEM_KINDS };

export function createStore({ dbPath, logger, config: explicitConfig, notifyDispatch = false, notifyUrl = null } = {}) {
  const finalPath = dbPath || resolveDbPath();
  const { sqlite: db, orm } = openDatabase({ dbPath: finalPath, logger });
  const cfg = resolveConfig({ explicit: explicitConfig ?? {} });
  const core = createCore({ db, cfg });

  const apis = {};
  apis.item = createItemApi({ core });
  apis.attempt = createAttemptApi({ core });
  apis.artifact = createArtifactApi({ core });
  apis.epic = createEpicApi({ core, apis });
  apis.story = createStoryApi({ core, apis });

  const task = createTaskApi({ core, apis });
  apis.task = task;
  Object.assign(
    task,
    createClaimMethods({ core, apis }),
    createGateMethods({ core, apis }),
    createSweepMethods({ core, apis }),
  );

  apis.dep = createDepApi({ core });
  apis.webhook = createWebhookApi({ core });
  apis.event = createEventApi({ core });
  apis.admission = createAdmissionApi({ core });
  apis.delivery = createDeliveryApi({ core });
  apis.dispatchEvent = createDispatchEventApi({ core });

  const notifyBase = process.env.WINCH_DISPATCH_URL ?? `http://127.0.0.1:${cfg.dispatchPort}`;
  const targetUrl = notifyUrl ?? `${notifyBase.replace(/\/+$/, "")}/dispatch/notify`;
  let notifyScheduled = false;

  function scheduleNotify() {
    if (!notifyDispatch || notifyScheduled) return;
    notifyScheduled = true;
    queueMicrotask(() => {
      notifyScheduled = false;
      const headers = { "content-type": "application/json" };
      const token = String(process.env.WINCH_DISPATCH_TOKEN ?? "").trim();
      if (token) headers.authorization = `Bearer ${token}`;
      fetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "notify" }),
        signal: AbortSignal.timeout(500),
      }).catch(() => {});
    });
  }

  const store = {
    db,
    orm,
    path: finalPath,
    config: cfg,
    item: apis.item,
    state: {
      get(itemId) {
        const r = db.prepare("SELECT * FROM item_state WHERE item_id=?").get(itemId);
        return r ? { ...r, state_json: jsonIn(r.state_json) ?? {} } : null;
      },
    },
    attempt: apis.attempt,
    session: {
      ensure: core.ensureSession,
      get(id) { return db.prepare("SELECT * FROM work_sessions WHERE id=?").get(id) ?? null; },
      forItem(itemId) { return db.prepare("SELECT * FROM work_sessions WHERE item_id=? ORDER BY created_at DESC").all(itemId); },
    },
    artifact: apis.artifact,
    event: apis.event,
    admission: apis.admission,
    delivery: apis.delivery,
    dispatchEvent: apis.dispatchEvent,
    epic: apis.epic,
    story: apis.story,
    task: apis.task,
    dep: apis.dep,
    webhook: apis.webhook,
    itemKindOf(id) { return apis.item.kindOf(id); },
    close() { db.close(); },
  };

  core.setEventHook((eventId) => {
    const row = core.eventById(eventId);
    if (!row) return;
    observe(store, toEventMessage(store, row, { includeArtifacts: false }), row.created_at ?? Date.now());
    scheduleNotify();
  });

  return store;
}
