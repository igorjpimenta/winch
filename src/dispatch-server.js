// dispatch-server.js — HTTP dispatch endpoints and the admission queue pump.
// Executors register here and winch POSTs wakes from here; the read-only event
// stream lives in events-ws.js and shares no socket with dispatch.

import http from "node:http";
import { observe, recover, tick as dispatchTick } from "./dispatch.js";
import { deliverWake } from "./dispatch-webhook.js";
import { eventsSince, lastEventId, toEventMessage, HISTORY_LIMIT } from "./events-ws.js";

export const DEFAULT_DISPATCH_PORT = 38293;

export function startDispatchServer({ store, port = null, host = "127.0.0.1", intervalMs = null, logger } = {}) {
  const cfg = store.config ?? {};
  const listenPort = port ?? cfg.dispatchPort ?? DEFAULT_DISPATCH_PORT;
  const pollMs = intervalMs ?? cfg.dispatchIntervalMs ?? 1000;
  const sweepMs = cfg.dispatchSweepMs ?? 30000;
  const consumerTtlMs = cfg.dispatchConsumerTtlMs ?? 90000;
  const histLimit = cfg.wsHistoryLimit ?? HISTORY_LIMIT;
  let closing = false;
  let pumping = false;

  const pruneConsumers = () => {
    try { store.webhook.prune({ topic: "dispatch", before: Date.now() - consumerTtlMs }); } catch {}
  };
  const sweeper = sweepMs > 0
    ? setInterval(() => {
        try { store.task.sweepExpired({}); } catch {}
        pruneConsumers();
      }, sweepMs)
    : null;
  sweeper?.unref?.();

  store.admission.resetOffers();
  pruneConsumers();
  // Repair a queue written before write-time routing existed. `enqueue` is
  // idempotent per event, so replaying tells the same story without minting a
  // second wake for rows the write hook already admitted.
  let since = 0;
  const cursor = lastEventId(store);
  for (;;) {
    const rows = eventsSince(store, since, histLimit);
    if (!rows.length) break;
    for (const row of rows) observe(store, toEventMessage(store, row), Date.now());
    since = rows[rows.length - 1].id;
    if (since >= cursor) break;
  }

  function json(res, status, body) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  async function readJson(req, res) {
    let size = 0;
    let raw = "";
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) {
        json(res, 413, { error: "body too large" });
        return undefined;
      }
      raw += chunk;
    }
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      json(res, 400, { error: "invalid json body" });
      return undefined;
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      pruneConsumers();
      const offered = dispatchTick(store, {
        at: Date.now(),
        reachable: store.webhook.harnesses({ topic: "dispatch" }),
        config: cfg,
      });
      for (const row of offered) await deliverWake(store, row, { config: cfg, logger });
    } catch (err) {
      logger?.warn?.(`winch: dispatch pump failed: ${err?.message ?? err}`);
    } finally {
      pumping = false;
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/dispatch/register") {
      const body = await readJson(req, res);
      if (body === undefined) return;
      try {
        const harness = typeof body.harness === "string" ? body.harness.trim() : "";
        const executorId = typeof body.executorId === "string" ? body.executorId.trim() : "";
        const consumerId = typeof body.consumerId === "string" ? body.consumerId.trim() : "";
        if (!harness || (!consumerId && !executorId)) throw new Error("dispatch registration requires harness and consumerId or executorId");
        const id = consumerId || executorId;
        const row = store.webhook.upsert({
          topic: "dispatch",
          id,
          harness,
          executorId: executorId || null,
          url: body.url,
          bearer: body.bearer,
          timeoutMs: body.timeoutMs ?? null,
        });
        if (executorId && id !== executorId) {
          const legacy = store.webhook.get({ topic: "dispatch", id: executorId });
          if (legacy?.executorId === executorId) store.webhook.remove({ topic: "dispatch", id: executorId });
        }
        json(res, 201, { ok: true, topic: row.topic, id: row.id, harness: row.harness, executorId: row.executorId });
        void pump();
      } catch (err) {
        json(res, 400, { error: String(err?.message ?? err) });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/dispatch/notify") {
      req.resume();
      json(res, 202, { ok: true });
      void pump();
      return;
    }
    if (req.method === "POST" && url.pathname === "/dispatch/recover") {
      const body = await readJson(req, res);
      if (body === undefined) return;
      try {
        const result = recover(store, {
          harness: String(body.harness ?? "").trim(),
          consumerId: String(body.consumerId ?? "").trim() || null,
          at: Date.now(),
          config: cfg,
        });
        json(res, 200, result);
      } catch (err) {
        json(res, 400, { error: String(err?.message ?? err) });
      }
      return;
    }
    json(res, 404, { error: "not found" });
  });

  const timer = setInterval(() => {
    if (closing) return;
    void pump();
  }, pollMs);
  if (typeof timer.unref === "function") timer.unref();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, host, () => {
      resolve({
        port: server.address().port,
        host,
        close: () =>
          new Promise((res) => {
            closing = true;
            clearInterval(timer);
            if (sweeper) clearInterval(sweeper);
            server.close(() => res());
          }),
      });
    });
  });
}
