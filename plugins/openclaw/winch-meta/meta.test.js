// meta.test.js — pure-function tests for the openclaw companion hook; runs
// under `node --test plugins/` (part of `npm test`) with no gateway runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isWinchTool, buildWinchMeta } from "./meta.js";

test("isWinchTool matches the mcp__winch__ naming and rejects other tools", () => {
  assert.equal(isWinchTool("mcp__winch__backlog_next"), true);
  assert.equal(isWinchTool("mcp__winch__backlog_done"), true);
  assert.equal(isWinchTool("mcp__gbrain__query"), false);
  assert.equal(isWinchTool("bash"), false);
  assert.equal(isWinchTool(undefined), false);
});

test("non-winch tool: undefined (call passes through untouched)", () => {
  assert.equal(
    buildWinchMeta({ toolName: "bash", params: { command: "ls" } }, { agentId: "a", sessionKey: "s" }),
    undefined,
  );
});

test("winch tool: stamps harness/agent/session from ctx fields", () => {
  const out = buildWinchMeta(
    { toolName: "mcp__winch__backlog_next", params: { capabilities: ["go"] } },
    { agentId: "scout", sessionKey: "ses_42" },
  );
  assert.deepEqual(out.params._meta.winch, { harness: "openclaw", agent: "scout", session: "ses_42" });
  assert.deepEqual(out.params.capabilities, ["go"]);
});

test("runId stands in for sessionKey — the browser-lease ownerFor fallback chain", () => {
  const out = buildWinchMeta({ toolName: "mcp__winch__backlog_done" }, { agentId: "scout", runId: "run_7" });
  assert.equal(out.params._meta.winch.session, "run_7");
});

test("ctx.sessionId beats runId — the 5.18-guaranteed HookContext field", () => {
  const out = buildWinchMeta(
    { toolName: "mcp__winch__backlog_next" },
    { agentId: "scout", sessionId: "ses_9", runId: "run_7" },
  );
  assert.equal(out.params._meta.winch.session, "ses_9");
});

test("sessionKey still wins over sessionId — most stable first", () => {
  const out = buildWinchMeta(
    { toolName: "mcp__winch__backlog_next" },
    { agentId: "scout", sessionKey: "ses_live", sessionId: "ses_9", runId: "run_7" },
  );
  assert.equal(out.params._meta.winch.session, "ses_live");
});

test("event.sessionId is read when ctx carries no session fields", () => {
  const out = buildWinchMeta({ toolName: "winch_x", sessionId: "ses_e" }, {});
  assert.equal(out.params._meta.winch.session, "ses_e");
  assert.equal(out.params._meta.winch.agent, null);
});

test("event.runId is read when ctx carries neither sessionKey nor runId", () => {
  const out = buildWinchMeta({ toolName: "winch_x", runId: "run_e" }, {});
  assert.equal(out.params._meta.winch.session, "run_e");
  assert.equal(out.params._meta.winch.agent, null);
});

test("no resolvable session or agent: undefined (server refuses the unstamped call)", () => {
  assert.equal(buildWinchMeta({ toolName: "mcp__winch__backlog_next", params: {} }, {}), undefined);
});

test("a model-supplied _meta.winch is overwritten, sibling keys preserved", () => {
  const out = buildWinchMeta(
    {
      toolName: "mcp__winch__backlog_next",
      params: { _meta: { winch: { harness: "evil", agent: "mallory", session: "s" }, progressToken: "p1" } },
    },
    { agentId: "scout", sessionKey: "ses_42" },
  );
  assert.deepEqual(out.params._meta.winch, { harness: "openclaw", agent: "scout", session: "ses_42" });
  assert.equal(out.params._meta.progressToken, "p1");
});

test("params is optional — a call with no params still gets stamped", () => {
  const out = buildWinchMeta({ toolName: "mcp__winch__backlog_next" }, { agentId: "a", sessionKey: "s" });
  assert.equal(out.params._meta.winch.harness, "openclaw");
});
