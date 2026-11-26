// usage.test.js — pure mapping and HTTP shape for the openclaw usage reporter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { accumulateUsage, carriesItemId, llmOutputUsage, reportReplyUsage, runUsageBody, usageFromReplyEvent, usageBody, postUsage } from "../../../../../plugins/openclaw/winch/usage.js";

test("maps a reply usage snapshot to winch usage", () => {
  const event = {
    runId: "run_1",
    sessionKey: "agent:main:ses_1",
    usageState: {
      resolvedRef: "anthropic/claude-sonnet-4-6",
      model: "claude-sonnet-4-6",
      agentId: "scout",
      sessionId: "ses_x",
      turnUsd: 0.0123,
      usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 0, total: 170 },
    },
  };
  assert.deepEqual(usageFromReplyEvent(event), {
    agent: "scout",
    session: "agent:main:ses_1",
    turnRef: "run_1",
    usage: { model: "anthropic/claude-sonnet-4-6", tokensIn: 100, tokensOut: 50, cacheRead: 20, costUsd: 0.0123 },
  });
});

test("falls back to lastUsage and sessionId", () => {
  const event = { runId: "r", usageState: { model: "m", agentId: "a", sessionId: "s", lastUsage: { input: 1, output: 2 } } };
  const out = usageFromReplyEvent(event);
  assert.equal(out.session, "s");
  assert.equal(out.usage.tokensIn, 1);
  assert.equal(out.usage.tokensOut, 2);
});

test("no snapshot or empty usage yields null", () => {
  assert.equal(usageFromReplyEvent({}), null);
  assert.equal(usageFromReplyEvent({ usageState: { usage: {} } }), null);
});

test("a cost-only snapshot still reports", () => {
  const out = usageFromReplyEvent({ runId: "r", sessionKey: "s", usageState: { agentId: "a", turnUsd: 0.5 } });
  assert.equal(out.usage.costUsd, 0.5);
  assert.equal(out.usage.tokensIn, null);
});

test("usageBody keys the harness:agent:session and refuses a missing agent", () => {
  assert.deepEqual(
    usageBody({ harness: "openclaw", agent: "a", session: "s", usage: { tokensIn: 1 }, turnRef: "t" }),
    { sessionKey: "openclaw:a:s", turnRef: "t", usage: { tokensIn: 1 } },
  );
  assert.equal(usageBody({ harness: "h", agent: null, session: "s", usage: {} }), null);
});

test("postUsage posts to /usage with the bearer", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
  const ok = await postUsage({ baseUrl: "http://127.0.0.1:1234/", token: "tok", body: { sessionKey: "x" }, fetchImpl });
  assert.equal(ok, true);
  assert.equal(calls[0].url, "http://127.0.0.1:1234/usage");
  assert.equal(calls[0].opts.headers.authorization, "Bearer tok");
  assert.equal(calls[0].opts.body, JSON.stringify({ sessionKey: "x" }));
});

test("a rejected usage post is swallowed", async () => {
  const logs = [];
  const ok = await postUsage({
    baseUrl: "http://127.0.0.1:1234",
    body: { sessionKey: "x" },
    fetchImpl: async () => { throw new Error("down"); },
    logger: { warn: (m) => logs.push(m) },
  });
  assert.equal(ok, false);
  assert.match(logs[0], /usage report failed/);
});

test("carriesItemId mirrors the server's item-binding keys", () => {
  assert.equal(carriesItemId({ taskId: "TASK-1" }), true);
  assert.equal(carriesItemId({ story_id: "STORY-1" }), true);
  assert.equal(carriesItemId({ admissionId: "ADM-1" }), false);
  assert.equal(carriesItemId({ id: "   " }), false);
  assert.equal(carriesItemId(null), false);
});

test("llmOutputUsage maps an attempt to a run-identified snapshot", () => {
  const snap = llmOutputUsage(
    { runId: "run_9", resolvedRef: "anthropic/claude-sonnet-4-6", usage: { input: 10, output: 5, cacheRead: 2 } },
    { sessionKey: "agent:main:winch:ITM-1", agentId: "main" },
  );
  assert.deepEqual(snap, {
    runId: "run_9",
    agent: "main",
    session: "agent:main:winch:ITM-1",
    usage: { model: "anthropic/claude-sonnet-4-6", tokensIn: 10, tokensOut: 5, cacheRead: 2 },
  });
});

test("llmOutputUsage falls back to provider/model and rejects unattributable attempts", () => {
  const snap = llmOutputUsage(
    { runId: "r", provider: "openai", model: "gpt-5.4", usage: { input: 1 } },
    { sessionKey: "s", agentId: "a" },
  );
  assert.equal(snap.usage.model, "openai/gpt-5.4");
  assert.equal(llmOutputUsage({ runId: "r", usage: {} }, { sessionKey: "s", agentId: "a" }), null);
  assert.equal(llmOutputUsage({ runId: "r", usage: { input: 1 } }, { sessionKey: "s" }), null);
  assert.equal(llmOutputUsage({ usage: { input: 1 } }, { sessionKey: "s", agentId: "a" }), null);
  assert.equal(llmOutputUsage(null, null), null);
});

test("accumulateUsage sums attempts per run and keeps the last model", () => {
  const runs = new Map();
  accumulateUsage(runs, { runId: "r1", agent: "main", session: "s", usage: { model: "m1", tokensIn: 10, tokensOut: 2, cacheRead: null } });
  accumulateUsage(runs, { runId: "r1", agent: "main", session: "s", usage: { model: "m2", tokensIn: 5, tokensOut: 3, cacheRead: 4 } });
  accumulateUsage(runs, { runId: "r2", agent: "main", session: "s", usage: { model: "m3", tokensIn: 1, tokensOut: 1, cacheRead: null } });
  assert.deepEqual(runs.get("r1"), { agent: "main", session: "s", usage: { model: "m2", tokensIn: 15, tokensOut: 5, cacheRead: 4 } });
  assert.equal(runs.size, 2);
});

test("accumulateUsage evicts oldest runs past the bound", () => {
  const runs = new Map();
  for (let i = 0; i < 3; i++) {
    accumulateUsage(runs, { runId: `r${i}`, agent: "a", session: "s", usage: { model: null, tokensIn: 1, tokensOut: null, cacheRead: null } }, 2);
  }
  assert.deepEqual([...runs.keys()], ["r1", "r2"]);
});

test("runUsageBody keys the flush body with turnRef=runId", () => {
  const runs = new Map();
  accumulateUsage(runs, { runId: "r1", agent: "main", session: "agent:main:winch:ITM-1", usage: { model: "m", tokensIn: 7, tokensOut: 1, cacheRead: null } });
  assert.deepEqual(
    runUsageBody({ event: { runId: "r1" }, runs, harness: "openclaw" }),
    { sessionKey: "openclaw:main:agent:main:winch:ITM-1", turnRef: "r1", usage: { model: "m", tokensIn: 7, tokensOut: 1, cacheRead: null } },
  );
  assert.equal(runUsageBody({ event: { runId: "nope" }, runs, harness: "openclaw" }), null);
  assert.equal(runUsageBody({ event: {}, runs, harness: "openclaw" }), null);
});

test("reportReplyUsage prefers the accumulator and still falls back to usageState", async () => {
  const posted = [];
  const fetchImpl = async (url, opts) => { posted.push(JSON.parse(opts.body)); return { ok: true }; };
  const runs = new Map();
  accumulateUsage(runs, { runId: "r1", agent: "main", session: "s", usage: { model: "m", tokensIn: 3, tokensOut: 2, cacheRead: null } });
  const body = reportReplyUsage({
    event: { runId: "r1", sessionKey: "s", usageState: { agentId: "other", usage: { input: 999, output: 999 } } },
    runs,
    harness: "openclaw",
    baseUrl: "http://127.0.0.1:1",
    fetchImpl,
  });
  assert.equal(body.turnRef, "r1");
  assert.equal(posted[0].usage.tokensIn, 3);

  const fallback = reportReplyUsage({
    event: { runId: "r2", sessionKey: "s2", usageState: { agentId: "a", resolvedRef: "m", usage: { input: 1, output: 2 } } },
    runs,
    harness: "openclaw",
    baseUrl: "http://127.0.0.1:1",
    fetchImpl,
  });
  assert.equal(fallback.turnRef, "r2");
  assert.equal(fallback.sessionKey, "openclaw:a:s2");
  assert.equal(posted.length, 2);

  assert.equal(reportReplyUsage({ event: {}, runs, harness: "h", baseUrl: "http://127.0.0.1:1", fetchImpl }), null);
  assert.equal(posted.length, 2);
});
