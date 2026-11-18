// events-ws.js — read-only event pipe plus the HTTP dispatch endpoints.
// Tails the item_events ledger and broadcasts every new row; dispatch wakes
// leave over executor webhooks, not this socket.
//
// Wire protocol (JSON text frames):
//   server → client:
//     {"type":"welcome","payload":"v3","lastEventId":N}
//     {"type":"history","events":[...]}   backlog of envelopes, oldest-first
//     {"type":"event","kind":...,"item":{...},...}  one flat envelope per new row, in id order
//
// Clients track their own seen state: reconnecting replays history, so a
// missed frame costs a re-read, never a lost event. The admission queue owns
// wake delivery and retry; MCP claim remains the work-level guard. No auth
// in-process — bind localhost, or put a bearer-checked reverse proxy in front.

import http from "node:http";
import crypto from "node:crypto";
import { collectStoryArtifacts } from "./tools/index.js";
import { readyTasks } from "./ready-queue.js";
import { HUMAN_AGENT } from "./reserved.js";
import { observe, recover, tick as dispatchTick } from "./dispatch.js";
import { deliverWake } from "./dispatch-webhook.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const DEFAULT_WS_PORT = 38291;
export const HISTORY_LIMIT = 200;

function acceptKey(key) {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}

// Server → client frames are never masked (RFC 6455 §5.3).
function encodeFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export function lastEventId(store) {
  return store.event.lastEventId();
}

export function eventsSince(store, id, limit = HISTORY_LIMIT) {
  return store.event.since(id, limit);
}

export function eventsLatest(store, limit = HISTORY_LIMIT) {
  return store.event.latest(limit);
}

// Stable kind for a stored transition. The closed catalog lives here, in
// one place — task.*: created, claimed, progressed, completed, released,
// blocked, cancelled, updated; gate.*: opened, resolved, dissolved — and
// the README names it by family only so the two cannot drift. A stored
// `kind` wins; otherwise the row maps by transition structure alone. Notes
// are free text and can change, so no branch here may read note content —
// a renamed note must never reclassify history.
//
// Pre-standardization rows still carry `todo` as a task status; map it with
// `ready` so the append-only history keeps the meaning it streamed with.
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
export function toEventMessage(store, row) {
  const item = !row.item_id ? null : store.item.get(row.item_id);
  const itemKind = item?.kind ?? null;
  const task = itemKind === "task" ? item : null;
  const story = itemKind === "story" ? item : task?.story_id ? store.story.get(task.story_id) : null;
  const epic = itemKind === "epic" ? item : story?.epic_id ? store.epic.get(story.epic_id) : item?.epic_id ? store.epic.get(item.epic_id) : null;
  const actorSession = row.session_id ? store.session.get(row.session_id) : null;
  return {
    type: "event",
    kind: kindForEvent(row),
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
    // Work that a close just made claimable: a dispatcher wakes these without
    // recomputing the dependency graph. Structural readiness only: capability
    // tags are the claimant's business, so a tagged task must still appear.
    // `todo` remains here for pre-standardization rows.
    unblocked: row.to_status === "done" || row.to_status === "cancelled" || row.to_status === "ready" || row.to_status === "todo"
      ? readyTasks(store, { ignoreCapabilities: true }).filter((r) => r.task.assignee_agent && r.task.assignee_agent !== HUMAN_AGENT).slice(0, 20)
          .map((r) => ({ id: r.task.id, assigned: r.task.assignee_agent, assigneeHarness: r.task.assignee_harness }))
      : [],
    task: task
      ? {
          id: task.id,
          title: task.title,
          story: story ? story.title : null,
          epic: epic ? epic.title : null,
          acceptance: story ? story.acceptance : null,
          artifacts: story ? collectStoryArtifacts(store, story.id) : [],
          assignee: task.assignee_agent,
        }
      : null,
    actor: row.actor,
    actorHarness: actorSession?.harness ?? null,
    note: row.note,
  };
}

export function startEventServer({ store, port = null, host = "127.0.0.1", intervalMs = null, historyLimit = null, logger } = {}) {
  const cfg = store.config ?? {};
  const listenPort = port ?? cfg.wsPort ?? DEFAULT_WS_PORT;
  const pollMs = intervalMs ?? cfg.wsIntervalMs ?? 1000;
  const histLimit = historyLimit ?? cfg.wsHistoryLimit ?? HISTORY_LIMIT;
  const clients = new Map();
  let closing = false;
  let cursor = lastEventId(store);
  let pumping = false;
  // The ws service is the only long-lived process winch guarantees, so it also
  // sweeps expired leases; without this a crashed worker holds its task until
  // a human runs the CLI.
  const sweepMs = cfg.wsSweepMs ?? 30000;
  const sweeper = sweepMs > 0
    ? setInterval(() => { try { store.task.sweepExpired({}); } catch {} }, sweepMs)
    : null;
  sweeper?.unref?.();

  store.admission.resetOffers();
  // The queue survives a server restart; events written while it was down do
  // not. Replay from the last admitted event, bounded to the history window on
  // a fresh store so an old ledger cannot replay everything.
  let since = store.admission.lastEventId();
  if (!since) since = Math.max(0, cursor - histLimit);
  for (;;) {
    const rows = eventsSince(store, since, histLimit);
    if (!rows.length) break;
    for (const row of rows) observe(store, toEventMessage(store, row), Date.now());
    since = rows[rows.length - 1].id;
    if (since >= cursor) break;
  }

  function send(socket, obj) {
    if (socket.destroyed || !socket.writable) return false;
    try {
      socket.write(encodeFrame(JSON.stringify(obj)));
      return true;
    } catch {
      return false;
    }
  }

  function broadcast(obj) {
    const frame = encodeFrame(JSON.stringify(obj));
    for (const client of [...clients.values()]) {
      const sock = client.socket;
      if (sock.destroyed || !sock.writable) {
        clients.delete(sock);
        continue;
      }
      sock.write(frame);
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

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if ((req.headers.upgrade || "").toLowerCase() !== "websocket" || !key) {
      socket.destroy();
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );
    const client = { socket, connectedAt: Date.now() };
    clients.set(socket, client);
    logger?.info?.(`winch: ws subscriber connected (${clients.size} total)`);
    try {
      send(socket, { type: "welcome", payload: "v3", lastEventId: cursor });
      send(socket, { type: "history", events: eventsLatest(store, histLimit).map((row) => toEventMessage(store, row)) });
    } catch {
      clients.delete(socket);
    }

    const drop = () => {
      clients.delete(socket);
      if (closing) return;
    };
    socket.on("close", drop);
    socket.on("error", drop);
  });

  const timer = setInterval(() => {
    try {
      const rows = eventsSince(store, cursor, histLimit);
      if (rows.length) {
        cursor = rows[rows.length - 1].id;
        for (const row of rows) {
          const msg = toEventMessage(store, row);
          broadcast(msg);
          observe(store, msg, Date.now());
        }
      }
      void pump();
    } catch (err) {
      logger?.warn?.(`winch: event poll failed: ${err?.message ?? err}`);
    }
  }, pollMs);
  if (typeof timer.unref === "function") timer.unref();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, host, () => {
      resolve({
        port: server.address().port,
        host,
        clients: () => clients.size,
        close: () =>
          new Promise((res) => {
            closing = true;
            clearInterval(timer);
            if (sweeper) clearInterval(sweeper);
            for (const client of clients.values()) client.socket.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}
