// server.js — HTTP dispatch endpoints and the admission queue pump.
// Executors register here and winch POSTs webhook wakes from here; webhook
// delivery is the main event driver.

import http from "node:http";
import { observe, recover, tick as dispatchTick } from "./core.js";
import { deliverDue, deliverWake } from "./delivery.js";
import { StaleRegistrationError } from "../store/webhook.js";
import { eventsSince, lastEventId, toEventMessage, HISTORY_LIMIT } from "./envelope.js";

export const DEFAULT_DISPATCH_PORT = 38293;

const USAGE_NUM = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Canonical usage shape from the harness. Accepts snake_case aliases so a
// plugin need not match our field names exactly. Returns null when nothing
// numeric/identifiable is present, so the endpoint rejects empty payloads.
function normalizeUsage(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const model = typeof raw.model === "string" && raw.model.trim() !== "" ? raw.model.trim() : null;
  const out = {
    model,
    tokensIn: USAGE_NUM(raw.tokensIn ?? raw.tokens_in ?? raw.inputTokens ?? raw.input_tokens),
    tokensOut: USAGE_NUM(raw.tokensOut ?? raw.tokens_out ?? raw.outputTokens ?? raw.output_tokens),
    cacheRead: USAGE_NUM(raw.cacheRead ?? raw.cache_read ?? raw.cachedTokens ?? raw.cached_tokens),
    costUsd: USAGE_NUM(raw.costUsd ?? raw.cost_usd ?? raw.cost),
    toolCalls: USAGE_NUM(raw.toolCalls ?? raw.tool_calls),
  };
  if (out.model === null && out.tokensIn === null && out.tokensOut === null &&
      out.cacheRead === null && out.costUsd === null && out.toolCalls === null) {
    return null;
  }
  return out;
}

export function startDispatchServer({ store, port = null, host = "127.0.0.1", intervalMs = null, logger } = {}) {
  const cfg = store.config ?? {};
  const listenPort = port ?? cfg.dispatchPort ?? DEFAULT_DISPATCH_PORT;
  const pollMs = intervalMs ?? cfg.dispatchIntervalMs ?? 1000;
  const sweepMs = cfg.dispatchSweepMs ?? 30000;
  const consumerTtlMs = cfg.dispatchConsumerTtlMs ?? 90000;
  const histLimit = cfg.eventHistoryLimit ?? HISTORY_LIMIT;
  const authToken = String(process.env.WINCH_DISPATCH_TOKEN ?? "").trim() || null;
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!loopback && !authToken) {
    throw new Error("winch: dispatch server refuses a non-loopback host without WINCH_DISPATCH_TOKEN");
  }
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

  function unauthorized(req) {
    if (!authToken) return false;
    const auth = req.headers?.authorization ?? "";
    return auth !== `Bearer ${authToken}`;
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
      await deliverDue(store, { config: cfg, logger });
    } catch (err) {
      logger?.warn?.(`winch: dispatch pump failed: ${err?.message ?? err}`);
    } finally {
      pumping = false;
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/dispatch/register") {
      if (unauthorized(req)) { json(res, 401, { error: "unauthorized" }); return; }
      const body = await readJson(req, res);
      if (body === undefined) return;
      try {
        const harness = typeof body.harness === "string" ? body.harness.trim() : "";
        const executorId = typeof body.executorId === "string" ? body.executorId.trim() : "";
        const consumerId = typeof body.consumerId === "string" ? body.consumerId.trim() : "";
        const instanceId = typeof body.instanceId === "string" ? body.instanceId.trim() : "";
        const fresh = body.fresh === true;
        if (!harness || (!consumerId && !executorId)) throw new Error("dispatch registration requires harness and consumerId or executorId");
        const id = consumerId || executorId;
        const row = store.webhook.upsert({
          topic: "dispatch",
          id,
          harness,
          executorId: executorId || null,
          instanceId: instanceId || executorId || id,
          url: body.url,
          bearer: body.bearer,
          timeoutMs: body.timeoutMs ?? null,
          leaseMs: consumerTtlMs,
          managed: true,
          fresh,
        });
        json(res, 201, {
          ok: true, topic: row.topic, id: row.id, harness: row.harness,
          executorId: row.executorId, instanceId: row.instanceId,
          generation: row.generation, leaseUntil: row.leaseUntil,
        });
        void pump();
      } catch (err) {
        if (err instanceof StaleRegistrationError || err?.code === "stale_instance") {
          const current = err.current
            ? { instanceId: err.current.instanceId ?? null, generation: err.current.generation ?? null,
                state: err.current.state ?? null, leaseUntil: err.current.leaseUntil ?? null }
            : null;
          json(res, 409, { error: String(err.message ?? err), code: "stale_instance", current });
        } else {
          json(res, 400, { error: String(err?.message ?? err) });
        }
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/dispatch/notify") {
      if (unauthorized(req)) { json(res, 401, { error: "unauthorized" }); return; }
      req.resume();
      json(res, 202, { ok: true });
      void pump();
      return;
    }
    if (req.method === "POST" && url.pathname === "/dispatch/recover") {
      if (unauthorized(req)) { json(res, 401, { error: "unauthorized" }); return; }
      const body = await readJson(req, res);
      if (body === undefined) return;
      try {
        const result = recover(store, {
          harness: String(body.harness ?? "").trim(),
          consumerId: String(body.consumerId ?? "").trim() || null,
          at: Date.now(),
          config: cfg,
          mutate: true,
        });
        json(res, 200, result);
      } catch (err) {
        json(res, 400, { error: String(err?.message ?? err) });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/usage") {
      if (unauthorized(req)) { json(res, 401, { error: "unauthorized" }); return; }
      const body = await readJson(req, res);
      if (body === undefined) return;
      try {
        const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey.trim() : "";
        if (!sessionKey) throw new Error("usage requires sessionKey");
        const usage = normalizeUsage(body.usage);
        if (!usage) throw new Error("usage requires a non-empty usage object");
        const sess = store.db.prepare(
          "SELECT id, item_id, harness, agent_id, external_session_id FROM work_sessions WHERE session_key=?"
        ).get(sessionKey);
        if (!sess) { json(res, 404, { error: `no session: ${sessionKey}` }); return; }
        const live = store.db.prepare(
          "SELECT id FROM attempts WHERE item_id=? AND ended_at IS NULL ORDER BY attempt_no DESC LIMIT 1"
        ).get(sess.item_id);
        const turnRef = typeof body.turnRef === "string" && body.turnRef.trim() !== "" ? body.turnRef.trim() : null;
        const id = store.usage.record({
          harness: sess.harness,
          agent: sess.agent_id,
          session: sess.external_session_id,
          itemId: sess.item_id,
          sessionId: sess.id,
          attemptId: live?.id ?? null,
          usage,
          source: "api",
          turnRef,
        });
        json(res, 201, { ok: true, id, itemId: sess.item_id, duplicate: id === null });
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
