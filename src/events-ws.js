// events-ws.js — dumb event pipe over WebSocket. Tails the item_events ledger and
// broadcasts every new row to all connected clients, verbatim. No
// interpretation, no filtering, no notify logic: a gate opening is just
// another row, and what it means — ping, dashboard card, digest line — is the
// subscriber's decision.
//
// Wire protocol (JSON text frames, server → client only):
//   {"type":"welcome","lastEventId":N}    on connect (current max row id)
//   {"type":"history","events":[...]}     backlog of envelopes, oldest-first
//   {"type":"event","event":{...}}        one envelope per new row, in id order
// Clients track their own seen state: reconnecting replays history, so a
// missed frame costs a re-read, never a lost event. No auth in-process —
// bind localhost, or put a bearer-checked reverse proxy in front.

import http from "node:http";
import crypto from "node:crypto";
import { collectStoryArtifacts } from "./tools/index.js";
import { readyTasks } from "./ready-queue.js";

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
export function kindForEvent(row) {
  if (row.kind) return row.kind;
  const from = row.from_status;
  const to = row.to_status;
  if (from == null) return "task.created";
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
  const item = !row.item_id ? null : store.item.get(row.item_id);
  const itemKind = item?.kind ?? null;
  const task = itemKind === "task" ? item : null;
  const story = itemKind === "story" ? item : task?.story_id ? store.story.get(task.story_id) : null;
  const epic = itemKind === "epic" ? item : story?.epic_id ? store.epic.get(story.epic_id) : item?.epic_id ? store.epic.get(item.epic_id) : null;
  return {
    type: "event",
    kind: kindForEvent(row),
    id: row.id,
    at: row.created_at,
    // Normalised item: a dispatcher routes assignment and review wakes without
    // knowing which level the row is about.
    item: item
      ? {
          id: item.id,
          kind: itemKind,
          title: item.title,
          status: item.status,
          assigned: item.assignee_agent ?? null,
          createdBy: item.created_by ?? null,
        }
      : null,
    epicId: epic?.id ?? null,
    epicCreatedBy: epic?.created_by ?? null,
    storyId: story?.id ?? null,
    storyAssigned: story?.assignee_agent ?? null,
    // Work that a close just made claimable: a dispatcher wakes these without
    // recomputing the dependency graph. Structural readiness only: capability
    // tags are the claimant's business, so a tagged task must still appear.
    unblocked: row.to_status === "done" || row.to_status === "cancelled" || row.to_status === "todo"
      ? readyTasks(store, { ignoreCapabilities: true }).filter((r) => r.task.assignee_agent).slice(0, 20)
          .map((r) => ({ id: r.task.id, assigned: r.task.assignee_agent }))
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
    note: row.note,
  };
}

export function startEventServer({ store, port = null, host = "127.0.0.1", intervalMs = null, historyLimit = null, logger } = {}) {
  const cfg = store.config ?? {};
  const listenPort = port ?? cfg.wsPort ?? DEFAULT_WS_PORT;
  const pollMs = intervalMs ?? cfg.wsIntervalMs ?? 1000;
  const histLimit = historyLimit ?? cfg.wsHistoryLimit ?? HISTORY_LIMIT;
  const clients = new Set();
  let cursor = lastEventId(store);
  // The ws service is the only long-lived process winch guarantees, so it also
  // sweeps expired leases; without this a crashed worker holds its task until
  // a human runs the CLI.
  const sweepMs = cfg.wsSweepMs ?? 30000;
  const sweeper = sweepMs > 0
    ? setInterval(() => { try { store.task.sweepExpired({}); } catch {} }, sweepMs)
    : null;
  sweeper?.unref?.();

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
      socket.write(encodeFrame(JSON.stringify({ type: "history", events: eventsSince(store, 0, histLimit).map((row) => toEventMessage(store, row)) })));
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
    const drop = () => clients.delete(socket);
    socket.on("close", drop);
    socket.on("error", drop);
  });

  const timer = setInterval(() => {
    try {
      const rows = eventsSince(store, cursor, histLimit);
      if (!rows.length) return;
      cursor = rows[rows.length - 1].id;
      for (const row of rows) broadcast(toEventMessage(store, row));
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
            clearInterval(timer);
            if (sweeper) clearInterval(sweeper);
            for (const s of clients) s.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}
