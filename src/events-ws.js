// events-ws.js — dumb event pipe over WebSocket. Tails the events table and
// broadcasts every new row to all connected clients, verbatim. No
// interpretation, no filtering, no notify logic: a gate opening is just
// another row, and what it means — ping, dashboard card, digest line — is the
// subscriber's decision.
//
// Wire protocol (JSON text frames, server → client only):
//   {"type":"welcome","lastEventId":N}    on connect (current max row id)
//   {"type":"history","events":[...]}     backlog, oldest-first, capped
//   {"type":"event","event":{...row...}}  one per new row, in id order
// Clients track their own seen state: reconnecting replays history, so a
// missed frame costs a re-read, never a lost event. No auth in-process —
// bind localhost, or put a bearer-checked reverse proxy in front.

import http from "node:http";
import crypto from "node:crypto";
import { collectStoryArtifacts } from "./tools.js";

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
  return store.db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM events").get().m;
}

export function eventsSince(store, id, limit = HISTORY_LIMIT) {
  return store.db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?").all(id, limit);
}

export function eventsLatest(store, limit = HISTORY_LIMIT) {
  return store.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit).reverse();
}

// Stable kind for a stored transition. The stored `kind` wins — producers
// declare it at write time (see insertEvent callers and kindForUpdate), so
// the wire reads the contract instead of inferring it. The rules below run
// only for pre-kind rows and exist solely as backfill over immutable note
// and transition text: the gate_type join is gone, retired by the migration
// that stamps provable gate.opened rows, because a join against mutable
// current state cannot classify immutable history. A mismatch between a
// stored kind and these rules means the producer lied, not that the rules
// need widening.
export function kindForEvent(row) {
  if (row.kind) return row.kind;
  const from = row.from_status;
  const to = row.to_status;
  const note = row.note ?? "";
  if (from == null) return "task.created";
  if (to === "blocked" && note.startsWith("gate open:")) return "gate.opened";
  if (from === "blocked" && to === "todo" && note === "gate resume") return "gate.resolved";
  if (from === "blocked" && to === "todo" && note.startsWith("gate dissolved")) return "gate.dissolved";
  if (from === "todo" && to === "in_progress") return "task.claimed";
  if (from === "in_progress" && to === "in_progress") return "task.progressed";
  if (to === "done") return "task.completed";
  if (to === "cancelled") return "task.cancelled";
  if (to === "blocked") return "task.blocked";
  if (to === "todo") return "task.released";
  return "task.updated";
}

// One envelope shape for history and live rows alike: the stored transition
// plus the task, story and epic context a subscriber would otherwise fetch
// once per row. Artifacts come from the same collector the claim handoff
// uses, so both paths agree on what "the artifacts" means.
export function toEventMessage(store, row) {
  const task = row.task_id ? store.task.get(row.task_id) : null;
  const story = task ? store.story.get(task.story_id) : null;
  const epic = story ? store.epic.get(story.epic_id) : null;
  return {
    type: "event",
    kind: kindForEvent(row),
    id: row.id,
    at: row.at,
    task: task
      ? {
          id: task.id,
          title: task.title,
          story: story ? story.title : null,
          epic: epic ? epic.title : null,
          acceptance: story ? story.acceptance : null,
          artifacts: story ? collectStoryArtifacts(store, story.id) : [],
          assignee: task.assigned,
        }
      : null,
    actor: row.actor,
    note: row.note,
  };
}

export function startEventServer({ store, port = DEFAULT_WS_PORT, host = "127.0.0.1", intervalMs = 1000, logger } = {}) {
  const clients = new Set();
  let cursor = lastEventId(store);

  function broadcast(obj) {
    const frame = encodeFrame(JSON.stringify(obj));
    for (const sock of [...clients]) {
      if (sock.destroyed || !sock.writable) {
        clients.delete(sock);
        continue;
      }
      sock.write(frame);
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
    clients.add(socket);
    logger?.info?.(`winch: ws subscriber connected (${clients.size} total)`);
    try {
      socket.write(encodeFrame(JSON.stringify({ type: "welcome", payload: "v2", lastEventId: cursor })));
      socket.write(encodeFrame(JSON.stringify({ type: "history", events: eventsSince(store, 0).map((row) => toEventMessage(store, row)) })));
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
        if (buf[1] & 0x80) off += 4;
        if (buf.length < off + len) return;
        buf = buf.slice(off + len);
        if (opcode === 0x8) {
          socket.destroy();
          return;
        }
        if (opcode === 0x9) socket.write(Buffer.from([0x8a, 0x00]));
      }
    });
    const drop = () => clients.delete(socket);
    socket.on("close", drop);
    socket.on("error", drop);
  });

  const timer = setInterval(() => {
    try {
      const rows = eventsSince(store, cursor);
      if (!rows.length) return;
      cursor = rows[rows.length - 1].id;
      for (const row of rows) broadcast(toEventMessage(store, row));
    } catch (err) {
      logger?.warn?.(`winch: event poll failed: ${err?.message ?? err}`);
    }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve({
        port: server.address().port,
        host,
        clients: () => clients.size,
        close: () =>
          new Promise((res) => {
            clearInterval(timer);
            for (const s of clients) s.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}
