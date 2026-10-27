// claim-webhook.test.js — push handoff on claim: disabled no-op, payload
// shape, delivery success, and failure-never-throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../../src/store.js";
import { createToolHandlers } from "../../src/tools.js";
import { webhookConfig, claimPayload, notifyClaim } from "../../src/claim-webhook.js";

function freshStore(config = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "backlog-hook-"));
  const store = createStore({ dbPath: path.join(dir, "store.sqlite"), config });
  return { dir, store };
}

function seed(store) {
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  return store.task.create({ storyId: story.id, title: "T" });
}

const ID = { harness: "openclaw", agent: "a1", session: "s1" };

test("webhookConfig: empty url disables; bearer optional; timeout default", () => {
  assert.equal(webhookConfig({ claimWebhookUrl: "", claimWebhookBearer: "", claimWebhookTimeoutMs: 3000 }), null);
  assert.equal(webhookConfig({}), null);
  const cfg = webhookConfig({ claimWebhookUrl: "http://x/hook", claimWebhookBearer: "", claimWebhookTimeoutMs: 0 });
  assert.equal(cfg.url, "http://x/hook");
  assert.equal(cfg.bearer, null);
  assert.equal(cfg.timeoutMs, 3000);
});

test("webhookConfig routes per harness, falls back to single, else disabled", () => {
  const cfg = {
    claimWebhookUrl: "http://fallback/hook",
    claimWebhookBearer: "fb",
    claimWebhookTimeoutMs: 3000,
    claimWebhooks: {
      openclaw: { url: "http://oc/hook", bearer: "oc-secret", timeoutMs: 1000 },
      opencode: { url: "http://oe/hook" },
    },
  };
  assert.deepEqual(webhookConfig(cfg, "openclaw"), { url: "http://oc/hook", bearer: "oc-secret", timeoutMs: 1000 });
  assert.deepEqual(webhookConfig(cfg, "opencode"), { url: "http://oe/hook", bearer: null, timeoutMs: 3000 });
  assert.deepEqual(webhookConfig(cfg, "langgraph"), { url: "http://fallback/hook", bearer: "fb", timeoutMs: 3000 });
  assert.equal(webhookConfig({ claimWebhookUrl: "", claimWebhooks: {} }, "openclaw"), null);
});

test("claimWebhooks knob parses JSON env and refuses malformed maps", async () => {
  const { resolveConfig } = await import("../../src/config.js");
  const cfg = resolveConfig({
    explicit: {},
    env: { WINCH_CLAIM_WEBHOOKS: '{"openclaw":{"url":"http://oc/h"}}' },
  });
  assert.deepEqual(cfg.claimWebhooks, { openclaw: { url: "http://oc/h" } });
  assert.throws(
    () => resolveConfig({ explicit: { claimWebhooks: { x: {} } }, env: {} }),
    /bad claimWebhooks/
  );
  assert.throws(
    () => resolveConfig({ explicit: {}, env: { WINCH_CLAIM_WEBHOOKS: "not-json{" } }),
    /bad claimWebhooks/
  );
});

test("notifyClaim POSTs to the claiming harness's own URL only", async () => {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ url: req.url, auth: req.headers.authorization, agent: JSON.parse(body).session.agent });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const port = server.address().port;
  const cfg = {
    claimWebhookUrl: "",
    claimWebhookBearer: "",
    claimWebhookTimeoutMs: 3000,
    claimWebhooks: {
      openclaw: { url: `http://127.0.0.1:${port}/oc`, bearer: "oc1" },
      opencode: { url: `http://127.0.0.1:${port}/oe`, bearer: "oe1" },
    },
  };
  const oc = await notifyClaim(cfg, { event: "task.claimed", session: { harness: "openclaw", agent: "a" } }, null);
  const oe = await notifyClaim(cfg, { event: "task.claimed", session: { harness: "opencode", agent: "b" } }, null);
  const lg = await notifyClaim(cfg, { event: "task.claimed", session: { harness: "langgraph", agent: "c" } }, null);
  server.close();
  assert.equal(oc.ok, true);
  assert.equal(oe.ok, true);
  assert.deepEqual(lg, { ok: false, reason: "disabled" });
  assert.deepEqual(hits.map((h) => [h.url, h.auth, h.agent]), [
    ["/oc", "Bearer oc1", "a"],
    ["/oe", "Bearer oe1", "b"],
  ]);
});

test("webhook registry CRUD: upsert/get/list/remove, validation", () => {
  const { dir, store } = freshStore();
  try {
    assert.equal(store.webhook.get("openclaw"), null);
    assert.deepEqual(store.webhook.list(), []);
    const row = store.webhook.upsert({ harness: "openclaw", url: "http://gw/hook", bearer: "s", timeoutMs: 1500 });
    assert.equal(row.harness, "openclaw");
    assert.equal(row.url, "http://gw/hook");
    assert.equal(row.timeoutMs, 1500);
    // upsert overwrites
    store.webhook.upsert({ harness: "openclaw", url: "http://gw2/hook" });
    const row2 = store.webhook.get("openclaw");
    assert.equal(row2.url, "http://gw2/hook");
    assert.equal(row2.bearer, null);
    assert.equal(store.webhook.list().length, 1);
    assert.equal(store.webhook.remove({ harness: "openclaw" }), true);
    assert.equal(store.webhook.remove({ harness: "openclaw" }), false);
    assert.throws(() => store.webhook.upsert({ harness: " ", url: "http://x/" }), /requires a harness/);
    assert.throws(() => store.webhook.upsert({ harness: "a", url: "not-a-url" }), /invalid webhook url/);
    assert.throws(() => store.webhook.upsert({ harness: "a", url: "ftp://x/y" }), /http\(s\)/);
    assert.throws(() => store.webhook.upsert({ harness: "a", url: "http://x/", timeoutMs: 0 }), /positive integer/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DB-registered target wins over env config", async () => {
  const { dir, store } = freshStore({
    claimWebhookUrl: "http://fallback/hook",
    claimWebhookBearer: "fb",
    claimWebhookTimeoutMs: 3000,
    claimWebhooks: {},
  });
  try {
    store.webhook.upsert({ harness: "openclaw", url: "http://db/hook", bearer: "db1" });
    assert.equal(
      webhookConfig(store.config, "openclaw", store.webhook.get("openclaw")).url,
      "http://db/hook"
    );
    assert.equal(
      webhookConfig(store.config, "langgraph", store.webhook.get("langgraph")).url,
      "http://fallback/hook"
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claimPayload carries task, session triple and handoff", () => {
  const p = claimPayload({
    task: { id: "TASK-1", title: "T", description: "D", assigned: "a1" },
    story: { id: "STORY-1", title: "S", acceptance: "A" },
    epic: { id: "EPIC-1", title: "E" },
    artifacts: ["a"],
    handoff: { reason: "ready-queue claim", receiverPrompt: "P" },
    identity: ID,
    sessionKey: "openclaw:a1:s1",
  });
  assert.equal(p.event, "task.claimed");
  assert.equal(p.task.id, "TASK-1");
  assert.deepEqual(p.session, { harness: "openclaw", agent: "a1", sessionKey: "openclaw:a1:s1" });
  assert.equal(p.handoff.receiverPrompt, "P");
});

test("backlog_next POSTs handoff on claim when configured", async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const url = `http://127.0.0.1:${server.address().port}/hook`;
  const { dir, store } = freshStore({ claimWebhookUrl: url, claimWebhookBearer: "s3cret" });
  try {
    seed(store);
    const { handle } = createToolHandlers(store, null);
    const r = await handle("backlog_next", {}, ID);
    assert.match(r.content[0].text, /"status":"ok"|"task"/);
    assert.equal(received.length, 1);
    assert.equal(received[0].auth, "Bearer s3cret");
    assert.equal(received[0].body.event, "task.claimed");
    assert.equal(received[0].body.session.agent, "a1");
    assert.match(received[0].body.handoff.receiverPrompt, /# Task: T/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    server.close();
  }
});

test("notifyClaim never throws: unreachable host, non-2xx", async () => {
  const bad = await notifyClaim(
    { claimWebhookUrl: "http://127.0.0.1:1/hook", claimWebhookBearer: "", claimWebhookTimeoutMs: 200 },
    { event: "task.claimed" },
    null
  );
  assert.equal(bad.ok, false);

  const server = http.createServer((req, res) => {
    res.writeHead(500);
    res.end("x");
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  try {
    const r500 = await notifyClaim(
      { claimWebhookUrl: `http://127.0.0.1:${server.address().port}/h`, claimWebhookBearer: "", claimWebhookTimeoutMs: 2000 },
      { event: "task.claimed" },
      null
    );
    assert.deepEqual(r500, { ok: false, reason: "http_500" });
  } finally {
    server.close();
  }
});

test("no webhook configured: claim succeeds silently", async () => {
  const { dir, store } = freshStore();
  try {
    seed(store);
    const { handle } = createToolHandlers(store, null);
    const r = await handle("backlog_next", {}, ID);
    assert.doesNotMatch(r.content[0].text, /claim webhook/);
    assert.equal(r.details.status, "ok");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
