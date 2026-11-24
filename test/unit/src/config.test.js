// config.test.js — layered tuning config: defaults, precedence
// (explicit > env > default), refusal paths, per-call meta overlay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../../../src/store/index.js";
import { createToolHandlers } from "../../../src/tools/index.js";
import { resolveConfig, resolveRequestConfig, CONFIG_DEFAULTS } from "../../../src/config.js";

function tempStore(t, config) {
  const dir = mkdtempSync(path.join(tmpdir(), "winch-config-"));
  const store = createStore({ dbPath: path.join(dir, "store.sqlite"), config });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

function seed(store) {
  const epic = store.epic.create({ title: "E", status: "in_progress" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "in_progress" });
  return store.task.create({ storyId: story.id, title: "T", executionKind: "manual", assigned: "atlas", assigneeHarness: "system" });
}

test("resolveConfig with nothing declared returns the documented defaults", () => {
  const cfg = resolveConfig({ explicit: {}, env: {} });
  assert.equal(cfg.leaseSeconds, 1800);
  assert.equal(cfg.maxAttempts, 3);
  assert.deepEqual(cfg.gateWaitLevels, [
    { ms: 24 * 3600 * 1000, label: "24h" },
    { ms: 72 * 3600 * 1000, label: "72h" },
  ]);
  assert.equal(cfg.mcpHttpPort, 38292);
  assert.equal(cfg.dispatchPort, 38293);
  assert.equal(cfg.webhookTimeoutMs, 3000);
  assert.equal(cfg.eventHistoryLimit, 200);
  assert.equal(cfg.maxActivePerAgent, 2);
  assert.equal(cfg.dispatchWakeMax, 8);
  assert.equal(cfg.candidates, 5);
  assert.ok(Object.keys(CONFIG_DEFAULTS).length >= 15, "defaults table covers every knob");
});

test("precedence is explicit > env > default", () => {
  const env = { WINCH_MAX_ATTEMPTS: "9", WINCH_MCP_HTTP_PORT: "40000" };
  const cfg = resolveConfig({ explicit: { maxAttempts: 4 }, env });
  assert.equal(cfg.maxAttempts, 4, "explicit wins over env");
  assert.equal(cfg.mcpHttpPort, 40000, "env wins over default");
  assert.equal(cfg.scanLimit, 50, "untouched knob stays default");
});

test("malformed config refuses, naming the key", () => {
  assert.throws(() => resolveConfig({ explicit: { maxAttempts: 0 }, env: {} }), /bad maxAttempts/);
  assert.throws(() => resolveConfig({ explicit: { mcpHttpPort: 99999 }, env: {} }), /bad mcpHttpPort/);
  assert.throws(() => resolveConfig({ explicit: { gateWaitLevels: "soon" }, env: {} }), /bad gateWaitLevels/);
  assert.throws(() => resolveConfig({ explicit: { someday: 1 }, env: {} }), /bad someday/, "unknown keys are typos until proven otherwise");
  assert.throws(() => resolveConfig({ explicit: "fast", env: {} }), /bad config/);
  assert.throws(() => resolveConfig({ explicit: {}, env: { WINCH_CANDIDATES: "many" } }), /bad candidates/);
});

test("per-call meta merges over construction; unknown ignored, malformed refused", () => {
  const base = resolveConfig({ explicit: {}, env: {} });
  assert.equal(resolveRequestConfig(base, null), base, "no meta is identity");
  assert.equal(resolveRequestConfig(base, {}), base, "empty meta is identity");
  const over = resolveRequestConfig(base, { winch: { config: { candidates: 2, futureKnob: 1 } } });
  assert.equal(over.candidates, 2);
  assert.equal(over.futureKnob, undefined, "unknown per-call keys ignored for forward compat");
  assert.equal(over.maxAttempts, base.maxAttempts, "untouched knobs survive");
  assert.throws(
    () => resolveRequestConfig(base, { winch: { config: { candidates: -1 } } }),
    /refused caller config.*bad candidates/,
    "malformed per-call knobs refuse the call, never the server"
  );
});

test("store honors construction config: lease length and sweep attempts", (t) => {
  const store = tempStore(t, { leaseSeconds: 60, maxAttempts: 1 });
  assert.equal(store.config.leaseSeconds, 60);
  const task = seed(store);
  const claimed = store.task.claim({ id: task.id, agentId: "atlas" });
  assert.equal(claimed.lease_seconds, 60, "claim derives from config, not the old 30min literal");
  store.db.prepare("UPDATE attempts SET claimed_at=1, heartbeat_at=1 WHERE item_id=? AND ended_at IS NULL").run(task.id);
  store.task.sweepExpired({});
  assert.equal(store.task.get(task.id).status, "blocked", "one strike escalates at maxAttempts 1");
});

test("per-call meta tunes a single tool call without touching the server", async (t) => {
  const store = tempStore(t, {});
  const { handle } = createToolHandlers(store, null);
  const epic = store.epic.create({ title: "E", status: "in_progress" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "in_progress" });
  const task = store.task.create({ storyId: story.id, title: "T", executionKind: "manual", assigned: "atlas", assigneeHarness: "system" });
  store.task.claim({ id: task.id, agentId: "atlas" });
  const id = { harness: "test", agent: "atlas", session: "s-1" };
  const long = "x".repeat(100);
  const dflt = await handle("backlog_update", { taskId: task.id, progressSummary: long }, id);
  assert.equal(dflt.details.status, "ok");
  const full = store.db.prepare("SELECT note FROM item_events WHERE item_id=? ORDER BY id DESC LIMIT 1").get(task.id).note;
  assert.ok(full.includes("x".repeat(100)), "default cap keeps the note whole");
  const tuned = await handle(
    "backlog_update", { taskId: task.id, progressSummary: long }, id,
    { winch: { config: { noteProgressLimit: 10 } } }
  );
  assert.equal(tuned.details.status, "ok");
  const cut = store.db.prepare("SELECT note FROM item_events WHERE item_id=? ORDER BY id DESC LIMIT 1").get(task.id).note;
  assert.ok(cut.includes("xxxxxxxxxx…"), "per-call cap truncates just this call");
});
