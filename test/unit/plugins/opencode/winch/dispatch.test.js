import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startDispatch } from "../../../../../plugins/opencode/winch/dispatch.js";

test("two dispatch instances in one process resume an attempt once", async () => {
  const resumeRow = {
    task: { id: "TASK-9", assignee_agent: "worker" },
    attemptId: "ATT-9",
    leaseEpoch: 1,
  };
  const core = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/dispatch/recover" ? { resume: [resumeRow], start: [] } : {}));
    });
  });
  await new Promise((r) => core.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${core.address().port}`;
  const calls = [];
  const make = () => startDispatch({
    baseUrl,
    harness: "opencode",
    consumerId: "opencode:test-host",
    executorId: "e1",
    bearer: "secret",
    wake: (frame) => { calls.push(frame); },
    logger: null,
    port: 0,
    reconcileMs: 0,
  });
  const first = make();
  const second = make();
  try {
    await Promise.all([first.ready, second.ready]);
    for (let i = 0; i < 50 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1, "one resume child per attempt per process");
    assert.equal(calls[0].attemptId, "ATT-9");
  } finally {
    await first.close();
    await second.close();
    await new Promise((r) => core.close(r));
  }
});

test("listener registers with core and accepts a wake", async () => {
  const registrations = [];
  const core = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      if (req.url === "/dispatch/register") registrations.push(JSON.parse(raw));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ resume: [], start: [] }));
    });
  });
  await new Promise((r) => core.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(path.join(tmpdir(), "winch-opencode-dispatch-"));
  const calls = [];
  const dispatch = startDispatch({
    baseUrl: `http://127.0.0.1:${core.address().port}`,
    harness: "opencode",
    consumerId: "opencode:test-host",
    executorId: "e1",
    bearer: "secret",
    wake: (frame) => { calls.push(frame); },
    logger: null,
    port: 0,
    reconcileMs: 0,
  });
  try {
    await dispatch.ready;
    for (let i = 0; i < 50 && registrations.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].harness, "opencode");
    assert.equal(registrations[0].consumerId, "opencode:test-host");
    assert.equal(registrations[0].executorId, "e1");
    assert.equal(registrations[0].instanceId, "e1");
    assert.match(registrations[0].url, /^http:\/\/127\.0\.0\.1:\d+\/wake$/);
    const ping = await fetch(registrations[0].url, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ type: "ping" }),
    });
    assert.equal(ping.status, 200);
    assert.equal(calls.length, 0);

    const res = await fetch(registrations[0].url, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ type: "wake", admissionId: "ADM-1", itemId: "TASK-1", agent: "worker", kind: "task" }),
    });
    assert.equal(res.status, 202);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].admissionId, "ADM-1");

    const standby = await fetch(registrations[0].url, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ type: "wake", admissionId: "ADM-2", itemId: "TASK-2", agent: "worker", kind: "task", execution: "standby" }),
    });
    assert.equal(standby.status, 202);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1, "a standby delivery does not start a session");
  } finally {
    await dispatch.close();
    await new Promise((r) => core.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
