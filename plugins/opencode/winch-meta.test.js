// winch-meta.test.js — the opencode companion stamps identity args.
// Runs under `node --test plugins/` with no opencode runtime: the hook is a
// pure function of (input, output).
import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "./winch-meta.js";

async function hooks(options) {
  return plugin.server({}, options);
}

test("winch tool: stamps agent session, preserves other args", async () => {
  const h = await hooks();
  const input = { tool: "winch__backlog_next", sessionID: "ses-1", callID: "c1" };
  const output = { args: { dryRun: true } };
  await h["tool.execute.before"](input, output);
  assert.deepEqual(output.args, { dryRun: true, winch_agent: "opencode", winch_session: "ses-1" });
});

test("model-supplied identity values are overwritten, never trusted", async () => {
  const h = await hooks();
  const input = { tool: "winch__backlog_done", sessionID: "ses-real", callID: "c2" };
  const output = { args: { taskId: "TASK-1", winch_agent: "mallory", winch_session: "ses-fake" } };
  await h["tool.execute.before"](input, output);
  assert.equal(output.args.winch_agent, "opencode");
  assert.equal(output.args.winch_session, "ses-real");
  assert.equal(output.args.taskId, "TASK-1");
});

test("non-winch tool: untouched", async () => {
  const h = await hooks();
  const output = { args: { command: "ls" } };
  await h["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, output);
  assert.deepEqual(output.args, { command: "ls" });
});

test("missing sessionID: unstamped, server refuses downstream", async () => {
  const h = await hooks();
  const output = { args: {} };
  await h["tool.execute.before"]({ tool: "winch__backlog_next", callID: "c" }, output);
  assert.deepEqual(output.args, {});
});

test("agent override via plugin options", async () => {
  const h = await hooks({ agent: "opencode-herculano" });
  const output = { args: {} };
  await h["tool.execute.before"]({ tool: "winch__backlog_next", sessionID: "s", callID: "c" }, output);
  assert.equal(output.args.winch_agent, "opencode-herculano");
});
