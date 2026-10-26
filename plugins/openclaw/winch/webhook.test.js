// webhook.test.js — claim webhook route: auth, shape validation, and the
// wake chain (fresh session → claiming session → injection-only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerClaimWebhook, registerClaimHeartbeat, claimError, claimMessage, claimSessionKey, notePendingClaim, heartbeatContext, clearPendingClaims, PENDING_TTL_MS } from "./webhook.js";

function makeReq({ method = "POST", headers = {}, body = "" } = {}) {
  return {
    method,
    headers,
    url: "/api/winch/claimed",
    async *[Symbol.asyncIterator]() {
      if (body) yield body;
    },
  };
}

function makeRes() {
  const captured = { statusCode: 200, headers: {}, body: "" };
  return {
    captured,
    res: {
      set statusCode(v) { captured.statusCode = v; },
      get statusCode() { return captured.statusCode; },
      setHeader(k, v) { captured.headers[k] = v; },
      end(text) { captured.body = String(text ?? ""); },
    },
  };
}

function makeApi({ bearer = "s3cret", scheduleImpl = null, injectImpl = null } = {}) {
  const calls = { scheduled: [], injected: [] };
  let route = null;
  const api = {
    pluginConfig: { webhookBearer: bearer },
    logger: { info() {}, warn() {} },
    registerHttpRoute(r) { route = r; },
    session: {
      workflow: {
        scheduleSessionTurn: scheduleImpl ?? (async (p) => {
          calls.scheduled.push(p);
          return { id: "job", pluginId: "winch", sessionKey: p.sessionKey, kind: "turn" };
        }),
        enqueueNextTurnInjection: injectImpl ?? (async (p) => {
          calls.injected.push(p);
          return { enqueued: true, id: "inj", sessionKey: p.sessionKey };
        }),
      },
    },
  };
  return { api, calls, get route() { return route; } };
}

const BODY = {
  event: "task.claimed",
  at: 1,
  task: { id: "TASK-abc", title: "T", story: { acceptance: "A" }, assignee: "a1" },
  session: { harness: "openclaw", agent: "a1", sessionKey: "openclaw:a1:s1" },
  handoff: { reason: "ready-queue claim", receiverPrompt: "# Task: T\nDo it." },
};

async function post(box, { headers = {}, body = BODY } = {}) {
  const route = box.route;
  const { res, captured } = makeRes();
  await route.handler(
    makeReq({ headers: { authorization: "Bearer s3cret", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }),
    res
  );
  return { ...captured, json: JSON.parse(captured.body) };
}

test("shape guards reject junk before any wake", () => {
  assert.match(claimError(null) ?? "", /object/);
  assert.match(claimError({ event: "nope" }) ?? "", /unsupported event/);
  assert.match(claimError({ event: "task.claimed" }) ?? "", /task.id/);
  assert.equal(claimError(BODY), null);
  assert.equal(claimSessionKey("TASK-abc"), "winch-claim-TASK-abc");
  assert.equal(claimMessage(BODY), "# Task: T\nDo it.");
  assert.match(claimMessage({ task: { id: "T1", title: "X" }, session: {} }), /Claimed winch task T1/);
});

test("no-scheduler wake parks the claim for the heartbeat hook", async () => {
  clearPendingClaims();
  const box = makeApi();
  delete box.api.session.workflow.scheduleSessionTurn;
  registerClaimWebhook({ api: box.api, logger: box.api.logger });
  const out = await post(box);
  assert.equal(out.json.scheduled, false);
  assert.equal(out.json.injected, true);
  const ctx = heartbeatContext({ agentId: "a1", sessionKey: "openclaw:a1:s1" });
  assert.match(ctx.appendContext, /TASK-abc/);
  assert.equal(heartbeatContext({ agentId: "nobody" }), undefined);
});

test("heartbeat context prefers session match, expires, registers hook", () => {
  clearPendingClaims();
  notePendingClaim({ agent: "a1", sessionKey: "s1" }, { task: { id: "T1" }, handoff: {} }, 1000);
  notePendingClaim({ agent: "a2", sessionKey: "s2" }, { task: { id: "T2" }, handoff: { receiverPrompt: "Do T2" } }, 1000);
  assert.equal(heartbeatContext({ agentId: "a2", sessionKey: "s2" }, 2000).appendContext.includes("Do T2"), true);
  // session match beats agent match
  assert.match(heartbeatContext({ agentId: "a1", sessionKey: "s1" }, 2000).appendContext, /T1/);
  // expired entries are dropped
  assert.equal(heartbeatContext({ agentId: "a1" }, 1000 + PENDING_TTL_MS + 1), undefined);
  let hook = null;
  const api = { on: (name, fn) => { hook = { name, fn }; } };
  assert.equal(registerClaimHeartbeat(api), true);
  assert.equal(hook.name, "heartbeat_prompt_contribution");
  clearPendingClaims();
  notePendingClaim({ agent: "a9", sessionKey: "s9" }, { task: { id: "T9" }, handoff: {} });
  assert.match(hook.fn({ agentId: "a9" }).appendContext, /T9/);
  assert.equal(registerClaimHeartbeat({}), false);
  clearPendingClaims();
});

test("webhook.test pings without waking anyone", async () => {
  const box = makeApi();
  registerClaimWebhook({ api: box.api, logger: box.api.logger });
  const out = await post(box, { body: { event: "webhook.test", at: 1 } });
  assert.equal(out.statusCode, 200);
  assert.deepEqual(JSON.parse(out.body), { ok: true, test: true });
  assert.equal(box.calls.scheduled.length, 0);
  assert.equal(box.calls.injected.length, 0);
});

test("405 on GET, 503 when disarmed, 401 on bad bearer", async () => {
  const box = makeApi();
  registerClaimWebhook({ api: box.api, logger: box.api.logger });
  assert.equal(box.route.path, "/api/winch/claimed");

  {
    const { res, captured } = makeRes();
    await box.route.handler(makeReq({ method: "GET" }), res);
    assert.equal(captured.statusCode, 405);
  }
  {
    const bare = makeApi({ bearer: "" });
    registerClaimWebhook({ api: bare.api, logger: bare.api.logger });
    const out = await post(bare);
    assert.equal(out.statusCode, 503);
  }
  {
    const out = await post(box, { headers: { authorization: "Bearer wrong" } });
    assert.equal(out.statusCode, 401);
  }
  {
    const out = await post(box, { body: { event: "task.claimed" } });
    assert.equal(out.statusCode, 400);
  }
});

test("200 opens a fresh session and injects into the claiming one", async () => {
  const box = makeApi();
  const { api, calls } = box;
  registerClaimWebhook({ api, logger: api.logger });
  const out = await post(box);
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.json, {
    ok: true,
    taskId: "TASK-abc",
    scheduled: true,
    scheduledSession: "winch-claim-TASK-abc",
    injected: true,
  });
  assert.equal(calls.scheduled.length, 1);
  assert.equal(calls.scheduled[0].sessionKey, "winch-claim-TASK-abc");
  assert.equal(calls.scheduled[0].deleteAfterRun, true);
  assert.equal(calls.scheduled[0].tag, "winch-claim");
  assert.match(calls.scheduled[0].message, /# Task: T/);
  assert.equal(calls.injected.length, 1);
  assert.equal(calls.injected[0].sessionKey, "openclaw:a1:s1");
});

test("fresh-session failure falls back to the claiming session", async () => {
  let n = 0;
  const box = makeApi({
    scheduleImpl: async (p) => {
      n += 1;
      box.calls.scheduled.push(p);
      if (n === 1) throw new Error("no such session");
      return { id: "job", pluginId: "winch", sessionKey: p.sessionKey, kind: "turn" };
    },
  });
  const { api, calls } = box;
  registerClaimWebhook({ api, logger: api.logger });
  const out = await post(box);
  assert.equal(out.json.scheduled, true);
  assert.equal(out.json.scheduledSession, "openclaw:a1:s1");
  assert.equal(out.json.injected, true);
});

test("no scheduler at all degrades to injection-only (never throws)", async () => {
  const box = makeApi();
  const { api } = box;
  delete api.session.workflow.scheduleSessionTurn;
  registerClaimWebhook({ api, logger: api.logger });
  const out = await post(box);
  assert.equal(out.statusCode, 200);
  assert.equal(out.json.scheduled, false);
  assert.equal(out.json.scheduledSession, null);
  assert.equal(out.json.injected, true);
});
