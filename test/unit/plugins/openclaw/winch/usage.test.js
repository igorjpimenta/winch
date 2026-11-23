// usage.test.js — pure mapping and HTTP shape for the openclaw usage reporter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { usageFromReplyEvent, usageBody, postUsage } from "../../../../../plugins/openclaw/winch/usage.js";

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
