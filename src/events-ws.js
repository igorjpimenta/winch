// events-ws.js — event pipe and dispatch transport over WebSocket. Tails the
// item_events ledger and broadcasts every new row verbatim; in core dispatch
// mode it also turns routable rows into queued wake offers and admits executors.
//
// Wire protocol (JSON text frames):
//   server → client:
//     {"type":"welcome","payload":"v3","lastEventId":N,"dispatchMode":"core|plugin","requiresHello":bool}
//     {"type":"history","events":[...]}   backlog of envelopes, oldest-first
//     {"type":"event","kind":...,"item":{...},...}  one flat envelope per new row, in id order
//     {"type":"hello_ok",...}             executor registered
//     {"type":"wake","admissionId":...,...}
//     {"type":"wake_granted","admissionId":...,...}
//     {"type":"wake_taken","admissionId":...,"reason":...}
//   client → server:
//     {"type":"hello","executorId":...,"harness":...}
//     {"type":"wake_accept","admissionId":...,"executorId":...}
//
// Clients track their own seen state: reconnecting replays history, so a
// missed frame costs a re-read, never a lost event. The admission queue is the
// one-winner guard; claim leases remain the work-level guard. No auth
// in-process — bind localhost, or put a bearer-checked reverse proxy in front.

import http from "node:http";
import crypto from "node:crypto";
import { collectStoryArtifacts } from "./tools/index.js";
import { readyTasks } from "./ready-queue.js";
import { HUMAN_AGENT } from "./reserved.js";
import { observe, tick as dispatchTick } from "./dispatch.js";

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
  const coreMode = (cfg.dispatchMode ?? "core") === "core";
  const listenPort = port ?? cfg.wsPort ?? DEFAULT_WS_PORT;
  const pollMs = intervalMs ?? cfg.wsIntervalMs ?? 1000;
  const histLimit = historyLimit ?? cfg.wsHistoryLimit ?? HISTORY_LIMIT;
  const clients = new Map();
  const executors = new Map();
  let closing = false;
  let cursor = lastEventId(store);
  // The ws service is the only long-lived process winch guarantees, so it also
  // sweeps expired leases; without this a crashed worker holds its task until
  // a human runs the CLI.
  const sweepMs = cfg.wsSweepMs ?? 30000;
  const sweeper = sweepMs > 0
    ? setInterval(() => { try { store.task.sweepExpired({}); } catch {} }, sweepMs)
    : null;
  sweeper?.unref?.();
  if (coreMode) {
    store.admission.resetOffers();
    // The queue survives a server restart; events written while it was down
    // do not. Replay from the last admitted event, bounded to the history
    // window on a fresh core store so an old ledger cannot replay everything.
    let since = store.admission.lastEventId();
    if (!since) since = Math.max(0, cursor - histLimit);
    for (;;) {
      const rows = eventsSince(store, since, histLimit);
      if (!rows.length) break;
      for (const row of rows) observe(store, toEventMessage(store, row), Date.now());
      since = rows[rows.length - 1].id;
      if (since >= cursor) break;
    }
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

  function reachableHarnesses() {
    return [...new Set([...executors.values()].map((c) => c.harness))];
  }

  function wakeFrame(row) {
    return {
      type: "wake",
      admissionId: row.id,
      itemId: row.item_id,
      kind: row.kind,
      harness: row.harness,
      agent: row.agent_id,
      eventId: row.event_id ?? null,
      offerExpiresAt: Date.now() + cfg.dispatchOfferMs,
    };
  }

  function sendWake(row, only = null) {
    const targets = only
      ? [only]
      : [...executors.values()].filter((c) => row.harness === "*" || c.harness === row.harness);
    for (const client of targets) send(client.socket, wakeFrame(row));
  }

  function pump() {
    if (!coreMode) return [];
    const offered = dispatchTick(store, {
      at: Date.now(),
      reachable: reachableHarnesses(),
      config: cfg,
    });
    for (const row of offered) sendWake(row);
    return offered;
  }

  function hello(client, msg) {
    const executorId = String(msg?.executorId ?? "").trim();
    const harness = String(msg?.harness ?? "").trim();
    if (!executorId || !harness) {
      send(client.socket, { type: "hello_rejected", reason: "executorId and harness are required" });
      return;
    }
    const existing = executors.get(executorId);
    if (existing && existing !== client) {
      send(client.socket, { type: "hello_rejected", reason: "duplicate executorId" });
      return;
    }
    if (client.executorId && client.executorId !== executorId) executors.delete(client.executorId);
    client.executorId = executorId;
    client.harness = harness;
    executors.set(executorId, client);
    send(client.socket, {
      type: "hello_ok",
      executorId,
      harness,
      dispatchMode: cfg.dispatchMode,
    });
    if (!coreMode) return;
    // Replay outstanding offers to a newcomer, then admit whatever is queued.
    for (const row of store.admission.offers(harness)) sendWake(row, client);
    pump();
  }

  function accept(client, msg) {
    if (!coreMode) return;
    if (!client.executorId) {
      send(client.socket, { type: "wake_taken", admissionId: String(msg?.admissionId ?? ""), reason: "hello required" });
      return;
    }
    const admissionId = String(msg?.admissionId ?? "");
    if (!admissionId) return;
    const result = store.admission.accept(admissionId, {
      executorId: client.executorId,
      harness: client.harness,
      at: Date.now(),
      harnessMax: cfg.dispatchHarnessMax,
    });
    if (result.granted) {
      send(client.socket, { ...wakeFrame(result.row), type: "wake_granted" });
    } else {
      send(client.socket, { type: "wake_taken", admissionId, reason: result.reason ?? null });
    }
  }

  const server = http.createServer((req, res) => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("winch events: websocket only — connect with an Upgrade request\n");
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
    const client = { socket, executorId: null, harness: null, connectedAt: Date.now() };
    clients.set(socket, client);
    logger?.info?.(`winch: ws subscriber connected (${clients.size} total)`);
    try {
      send(socket, { type: "welcome", payload: "v3", lastEventId: cursor, dispatchMode: cfg.dispatchMode, requiresHello: coreMode });
      send(socket, { type: "history", events: eventsSince(store, 0, histLimit).map((row) => toEventMessage(store, row)) });
    } catch {
      clients.delete(socket);
    }

    function text(raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg?.type === "hello") hello(client, msg);
      else if (msg?.type === "wake_accept") accept(client, msg);
    }

    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          if (buf.readUInt32BE(2) !== 0) {
            socket.destroy();
            return;
          }
          len = buf.readUInt32BE(6);
          off = 10;
        }
        if (len > 1024 * 1024) {
          socket.destroy();
          return;
        }
        const masked = (buf[1] & 0x80) !== 0;
        let mask = null;
        if (masked) {
          if (buf.length < off + 4) return;
          mask = buf.subarray(off, off + 4);
          off += 4;
        }
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len));
        if (mask && mask.length === 4) {
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }
        buf = buf.subarray(off + len);
        if (opcode === 0x8) {
          socket.destroy();
          return;
        }
        if (opcode === 0x9) {
          socket.write(Buffer.from([0x8a, 0x00]));
          continue;
        }
        if (opcode === 0x1) text(payload.toString("utf8"));
      }
    });
    const drop = () => {
      clients.delete(socket);
      if (closing) return;
      if (client.executorId && executors.get(client.executorId) === client) {
        executors.delete(client.executorId);
        store.admission.requeueExecutor(client.executorId, Date.now());
        pump();
      }
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
          if (coreMode) observe(store, msg, Date.now());
        }
      }
      if (coreMode) pump();
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
