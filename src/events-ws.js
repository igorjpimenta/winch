// events-ws.js — the read-only event pipe.
// Tails the item_events ledger and broadcasts every new row; dispatch wakes
// leave over executor webhooks served by dispatch-server.js, not this socket.
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
import { depsResolved } from "./deps.js";
import { HUMAN_AGENT } from "./reserved.js";

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

// Stable kind for a stored transition. Structural inference covers task.*
// (created, claimed, progressed, completed, released, blocked, cancelled,
// updated) and gate.* (opened, resolved, dissolved); producers may store
// story.*, deps.* and release.*. A stored `kind` wins; otherwise the row maps
// by transition structure alone. Notes are free text and can change, so no
// branch here may read note content —
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

export function startEventServer({ store, port = null, host = "127.0.0.1", intervalMs = null, historyLimit = null, logger } = {}) {
  const cfg = store.config ?? {};
  const listenPort = port ?? cfg.wsPort ?? DEFAULT_WS_PORT;
  const pollMs = intervalMs ?? cfg.wsIntervalMs ?? 1000;
  const histLimit = historyLimit ?? cfg.wsHistoryLimit ?? HISTORY_LIMIT;
  const clients = new Map();
  let closing = false;
  let cursor = lastEventId(store);

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

  const server = http.createServer((req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
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

    // Client frames are only ever interesting as close/ping; everything else
    // is consumed and ignored. Mask bit respected when skipping payloads.
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
        const masked = !!(buf[1] & 0x80);
        let maskKey = null;
        if (masked) {
          if (buf.length < off + 4) return;
          maskKey = buf.slice(off, off + 4);
          off += 4;
        }
        if (buf.length < off + len) return;
        let payload = buf.slice(off, off + len);
        if (masked && maskKey) {
          const out = Buffer.alloc(len);
          for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i % 4];
          payload = out;
        }
        buf = buf.slice(off + len);
        if (opcode === 0x8) {
          socket.destroy();
          return;
        }
        if (opcode === 0x9) { socket.write(Buffer.from([0x8a, 0x00])); return; }
        if (opcode === 0x1) {
          // Inbound usage frames: { type: "usage", sessionKey, usage }
          try {
            const msg = JSON.parse(payload.toString("utf8"));
            if (msg && msg.type === "usage" && msg.sessionKey && msg.usage) {
              const sess = store.db.prepare("SELECT item_id, harness, agent_id, external_session_id FROM work_sessions WHERE session_key=?").get(msg.sessionKey);
              if (sess) {
                let itemKind = null;
                const it = store.item.get(sess.item_id);
                if (it) itemKind = it.kind;
                store.usage.record({
                  harness: sess.harness,
                  agent: sess.agent_id,
                  session: sess.external_session_id,
                  itemId: sess.item_id,
                  itemKind,
                  usage: msg.usage,
                  source: "ws",
                });
              }
            }
          } catch (e) {
            logger?.warn?.(`winch: bad ws frame: ${e?.message}`);
          }
        }
      }
    });
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
          broadcast(toEventMessage(store, row));
        }
      }
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
            for (const client of clients.values()) client.socket.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}
