import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createWakeGuard, postSettle, recoverOnce, registerReceiver, resumePrompt } from "../../../../../plugins/openclaw/winch/dispatch.js";

test("recoverOnce wakes resume and start rows once", async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
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

  const standbyReq = Readable.from([JSON.stringify({
    type: "wake", admissionId: "ADM-2", itemId: "TASK-2", agent: "worker", kind: "task", execution: "standby",
  })]);
  standbyReq.method = "POST";
  standbyReq.headers = { authorization: "Bearer secret" };
  const standbyRes = { statusCode: 0, body: "", setHeader() {}, end(body) { this.body = body; } };
  await handler(standbyReq, standbyRes);
  assert.equal(standbyRes.statusCode, 202);
  assert.equal(calls.length, 1, "a standby delivery does not start a session");
});

test("resume prompt carries the attempt fence", () => {
  const text = resumePrompt({ task: { id: "TASK-9" }, attemptId: "a9" });
  assert.match(text, /TASK-9/);
  assert.match(text, /a9/);
  assert.match(text, /backlog_update/);
});

test("resume prompt repairs a missing attempt without fencing on unknown", () => {
  const text = resumePrompt({ task: { id: "TASK-9" }, attemptId: null, needsRepair: true });
  assert.match(text, /Repair TASK-9/);
  assert.match(text, /no attemptId/);
  assert.doesNotMatch(text, /attempt \(unknown\)/);
});

test("the wake guard dedups a key in flight and settles when the child exits", async () => {
  const spawned = [];
  const settled = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const guard = createWakeGuard(
    (frame) => gate.then(() => { spawned.push(frame.admissionId); }),
    { settle: (id) => settled.push(id) },
  );
  const first = guard({ admissionId: "ADM-1", itemId: "T", agent: "a" });
  const dup = await guard({ admissionId: "ADM-1", itemId: "T", agent: "a" });
  assert.deepEqual(dup, { deduped: true }, "the same admission resolves deduplicated while its child lives");
  assert.equal(spawned.length, 0);
  release();
  await first;
  assert.deepEqual(spawned, ["ADM-1"]);
  assert.deepEqual(settled, ["ADM-1"], "the exit settles the admission");
});

test("postSettle posts the settle frame to /dispatch/notify", async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
      res.statusCode = 202;
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await postSettle({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      admissionId: "ADM-2",
      consumerId: "openclaw:host",
      bearer: "tok",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/dispatch/notify");
    assert.equal(calls[0].auth, "Bearer tok");
    assert.equal(calls[0].body.type, "settle");
    assert.equal(calls[0].body.admissionId, "ADM-2");
    assert.equal(calls[0].body.consumerId, "openclaw:host");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
