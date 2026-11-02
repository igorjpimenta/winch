// index.test.js — the opencode adapter stamps a whole identity pair on winch
// calls, from the session's agent, and never trusts a model-supplied pair.
import test from "node:test";
import assert from "node:assert/strict";
import { createWinchHooks } from "./hooks.js";
import { isWinchTool, stampWinchIdentity, stampWinchEvent } from "./identity.js";

test("matches winch tools only", () => {
  assert.equal(isWinchTool("winch__backlog_claim"), true);
  assert.equal(isWinchTool("mcp__winch__backlog_get"), true);
  assert.equal(isWinchTool("read"), false);
  assert.equal(isWinchTool(null), false);
});

test("stamps the session and the known agent", () => {
  const output = { args: { taskId: "TASK-1" } };
  assert.equal(stampWinchIdentity({ tool: "winch__backlog_claim", sessionID: "ses_1" }, output, { agent: "builder" }), true);
  assert.deepEqual(output.args, { taskId: "TASK-1", winch_agent: "builder", winch_session: "ses_1" });
});

test("overwrites a model-supplied identity pair", () => {
  const output = { args: { winch_agent: "forged", winch_session: "forged" } };
  stampWinchIdentity({ tool: "winch__backlog_claim", sessionID: "ses_2" }, output, { agent: "builder" });
  assert.deepEqual(output.args, { winch_agent: "builder", winch_session: "ses_2" });
});

test("leaves non-winch calls untouched", () => {
  const output = { args: { path: "x" } };
  assert.equal(stampWinchIdentity({ tool: "read", sessionID: "ses_1" }, output, { agent: "builder" }), false);
  assert.deepEqual(output.args, { path: "x" });
});

test("hooks learn the agent from chat events and stamp the tool call", async () => {
  const hooks = createWinchHooks();
  await hooks["chat.message"]({ sessionID: "ses_9", agent: "docs" });
  const output = { args: {} };
  await hooks["tool.execute.before"]({ tool: "winch__backlog_get", sessionID: "ses_9" }, output);
  assert.deepEqual(output.args, { winch_agent: "docs", winch_session: "ses_9" });
});

test("chat.params also teaches the agent", async () => {
  const hooks = createWinchHooks();
  await hooks["chat.params"]({ sessionID: "ses_10", agent: "qa" });
  const output = { args: {} };
  await hooks["tool.execute.before"]({ tool: "winch__backlog_get", sessionID: "ses_10" }, output);
  assert.equal(output.args.winch_agent, "qa");
});

test("v2 event stamping writes the same unconditional pair", async () => {
  const event = { tool: "winch_backlog_claim", sessionID: "ses_v2", input: { taskId: "TASK-1" } };
  assert.equal(stampWinchEvent(event, "build"), true);
  assert.deepEqual(event.input, { taskId: "TASK-1", winch_agent: "build", winch_session: "ses_v2" });
  const forged = { tool: "winch_backlog_claim", sessionID: "ses_v2", input: { winch_agent: "forged" } };
  stampWinchEvent(forged, "build");
  assert.equal(forged.input.winch_agent, "build");
  assert.equal(stampWinchEvent({ tool: "read", sessionID: "s" }, "build"), false);
});

test("the package exposes both host entrypoints", async () => {
  const mod = await import("./index.js");
  const def = mod.default;
  assert.equal(typeof def.setup, "function", "v2 setup");
  assert.equal(typeof def.server, "function", "v1 server");
  assert.equal(def.id, "winch-opencode");
  const hooks = await def.server();
  assert.equal(typeof hooks["tool.execute.before"], "function");
});

test("an unknown agent blanks a model-supplied pair instead of trusting it", () => {
  const output = { args: { winch_agent: "forged", winch_session: "forged" } };
  stampWinchIdentity({ tool: "winch__backlog_claim", sessionID: "ses_1" }, output, { agent: null });
  assert.deepEqual(output.args, { winch_agent: "", winch_session: "ses_1" });
  const event = { tool: "winch_backlog_claim", sessionID: "ses_2", input: { winch_agent: "forged" } };
  stampWinchEvent(event, null);
  assert.equal(event.input.winch_agent, "");
  assert.equal(event.input.winch_session, "ses_2");
});
