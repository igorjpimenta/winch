import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { recoverOnce, registerReceiver, resumePrompt } from "../../../../../plugins/openclaw/winch/dispatch.js";

test("recoverOnce wakes resume and start rows once", async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/dispatch/accept") {
      res.end(JSON.stringify({ ok: true, accepted: true, attemptNo: 1 }));
      return;
    }
    res.end(JSON.stringify({
      resume: [{ task: { id: "TASK-1", assignee_agent: "worker" }, attemptId: "a1" }],
      start: [{ admissionId: "ADM-1", itemId: "TASK-2", agent: "worker", kind: "task", attemptNo: 1 }],
    }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const started = new Map();
    const wake = (frame) => { calls.push(frame); };
    await recoverOnce({ baseUrl: `http://127.0.0.1:${server.address().port}`, harness: "openclaw", executorId: "e1", wake, started, logger: null });
    await recoverOnce({ baseUrl: `http://127.0.0.1:${server.address().port}`, harness: "openclaw", executorId: "e1", wake, started, logger: null });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].kind, "resume");
    assert.equal(calls[0].attemptId, "a1");
    assert.match(calls[0].message, /Do not call backlog_claim/);
    assert.equal(calls[1].admissionId, "ADM-1");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("receiver rejects a bad bearer and accepts a wake", async () => {
  let handler;
  const api = { registerHttpRoute: (route) => { handler = route.handler; } };
  const calls = [];
  registerReceiver({
    api,
    bearer: "secret",
    wake: (frame) => { calls.push(frame); },
    accept: async () => ({ ok: true }),
    started: new Map(),
    logger: null,
  });

  const bad = { method: "POST", headers: { authorization: "Bearer nope" } };
  const badRes = { statusCode: 0, setHeader() {}, end() { this.done = true; } };
  await handler(bad, badRes);
  assert.equal(badRes.statusCode, 401);

  const pingReq = Readable.from([JSON.stringify({ type: "ping" })]);
  pingReq.method = "POST";
  pingReq.headers = { authorization: "Bearer secret" };
  const pingRes = { statusCode: 0, body: "", setHeader() {}, end(body) { this.body = body; } };
  await handler(pingReq, pingRes);
  assert.equal(pingRes.statusCode, 200);
  assert.equal(calls.length, 0);

  const req = Readable.from([JSON.stringify({ type: "wake", admissionId: "ADM-1", itemId: "TASK-1", agent: "worker", kind: "task" })]);
  req.method = "POST";
  req.headers = { authorization: "Bearer secret" };
  const res = { statusCode: 0, body: "", setHeader() {}, end(body) { this.body = body; } };
  await handler(req, res);
  assert.equal(res.statusCode, 202);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].admissionId, "ADM-1");
});

test("resume prompt carries the attempt fence", () => {
  const text = resumePrompt({ task: { id: "TASK-9" }, attemptId: "a9" });
  assert.match(text, /TASK-9/);
  assert.match(text, /a9/);
  assert.match(text, /backlog_update/);
});
