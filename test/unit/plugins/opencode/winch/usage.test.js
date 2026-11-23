// usage.test.js — pure mapping and HTTP shape for the opencode usage reporter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isFinalAssistant, usageFromAssistantMessage, usageBody, postUsage, remember } from "../../../../../plugins/opencode/winch/usage.js";

test("a final assistant message maps cost and tokens", () => {
  const info = {
    id: "msg_1",
    role: "assistant",
    sessionID: "ses_1",
    agent: "build",
    providerID: "anthropic",
    modelID: "claude-sonnet-4-6",
    cost: 0.02,
    tokens: { input: 10, output: 5, cache: { read: 3, write: 0 } },
    finish: "stop",
  };
  assert.deepEqual(usageFromAssistantMessage(info), {
    agent: "build",
    session: "ses_1",
    turnRef: "msg_1",
    usage: { model: "anthropic/claude-sonnet-4-6", tokensIn: 10, tokensOut: 5, cacheRead: 3, costUsd: 0.02 },
  });
});

test("ignores user messages and unfinished assistant messages", () => {
  assert.equal(usageFromAssistantMessage({ role: "user", tokens: { input: 1 } }), null);
  assert.equal(usageFromAssistantMessage({ role: "assistant", tokens: { input: 1 } }), null);
});

test("isFinalAssistant gates on role and completion", () => {
  assert.equal(isFinalAssistant({ role: "assistant" }), false);
  assert.equal(isFinalAssistant({ role: "assistant", finish: "stop" }), true);
  assert.equal(isFinalAssistant({ role: "user", finish: "stop" }), false);
});

test("a completed timestamp also marks the message final", () => {
  const info = { role: "assistant", time: { completed: 1 }, tokens: { input: 1 } };
  assert.ok(usageFromAssistantMessage(info));
});

test("usageBody keys the harness:agent:session", () => {
  assert.deepEqual(
    usageBody({ harness: "opencode", agent: "a", session: "s", usage: { costUsd: 1 }, turnRef: "t" }),
    { sessionKey: "opencode:a:s", turnRef: "t", usage: { costUsd: 1 } },
  );
});

test("remember dedups and keeps a bounded window", () => {
  const seen = new Set();
  assert.equal(remember(seen, "t1"), true);
  assert.equal(remember(seen, "t1"), false);
  remember(seen, "t2", 1);
  assert.equal(seen.size, 1);
  assert.equal(seen.has("t2"), true);
});

test("postUsage posts to /usage and a rejection is swallowed", async () => {
  const calls = [];
  const ok = await postUsage({
    baseUrl: "http://127.0.0.1:1234",
    token: "tok",
    body: { sessionKey: "x" },
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: true }; },
  });
  assert.equal(ok, true);
  assert.equal(calls[0].url, "http://127.0.0.1:1234/usage");
  assert.equal(calls[0].opts.headers.authorization, "Bearer tok");

  const logs = [];
  const failed = await postUsage({
    baseUrl: "http://127.0.0.1:1234",
    body: { sessionKey: "x" },
    fetchImpl: async () => { throw new Error("down"); },
    logger: { warn: (m) => logs.push(m) },
  });
  assert.equal(failed, false);
  assert.match(logs[0], /usage report failed/);
});
