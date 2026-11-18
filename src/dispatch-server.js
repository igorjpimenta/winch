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
  const histLimit = cfg.wsHistoryLimit ?? HISTORY_LIMIT;
  let closing = false;
  let pumping = false;

  const sweeper = sweepMs > 0
    ? setInterval(() => { try { store.task.sweepExpired({}); } catch {} }, sweepMs)
    : null;
  sweeper?.unref?.();

  store.admission.resetOffers();
  // The queue survives a restart; events written while the server was down do
  // not. Replay from the last admitted event, bounded on a fresh store so an
  // old ledger cannot replay everything.
  let since = store.admission.lastEventId();
  const cursor = lastEventId(store);
  if (!since) since = Math.max(0, cursor - histLimit);
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
      const offered = dispatchTick(store, {
        at: Date.now(),
        reachable: store.dispatch.harnesses(),
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
        const row = store.dispatch.upsert({
          harness: body.harness,
          executorId: body.executorId,
          url: body.url,
          bearer: body.bearer,
          timeoutMs: body.timeoutMs ?? null,
        });
        json(res, 201, { ok: true, harness: row.harness, executorId: row.executorId });
        void pump();
      } catch (err) {
        json(res, 400, { error: String(err?.message ?? err) });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/dispatch/recover") {
      const body = await readJson(req, res);
      if (body === undefined) return;
      try {
        const result = recover(store, { harness: String(body.harness ?? "").trim(), at: Date.now(), config: cfg });
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
