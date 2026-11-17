import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadExecutorState, startDispatch } from "./dispatch.js";

test("opencode executor state is stable", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "winch-opencode-dispatch-"));
  const statePath = path.join(dir, "state.json");
  try {
    const first = loadExecutorState(statePath);
    const second = loadExecutorState(statePath);
    assert.equal(first.executorId, second.executorId);
    assert.equal(first.bearer, second.bearer);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
  const statePath = path.join(dir, "state.json");
  const calls = [];
  const dispatch = startDispatch({
    baseUrl: `http://127.0.0.1:${core.address().port}`,
    harness: "opencode",
    wake: (frame) => { calls.push(frame); },
    statePath,
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
    assert.match(registrations[0].url, /^http:\/\/127\.0\.0\.1:\d+\/wake$/);
    const state = loadExecutorState(statePath);
    const res = await fetch(registrations[0].url, {
      method: "POST",
      headers: { authorization: `Bearer ${state.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "wake", admissionId: "ADM-1", itemId: "TASK-1", agent: "worker", kind: "task" }),
    });
    assert.equal(res.status, 202);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].admissionId, "ADM-1");
  } finally {
    await dispatch.close();
    await new Promise((r) => core.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
