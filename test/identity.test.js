// identity.test.js — the three-layer key is a construction requirement:
// complete declarations pass, incomplete ones throw by name, and per-request
// meta refines the declaration layer by layer with tagged sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertDeclaration, declaredFromEnv, resolveIdentity, identitySessionKey } from "../src/identity.js";

const FULL = { harness: "langgraph", agent: "planner", session: "graph-main" };

test("assertDeclaration: complete triple passes and trims", () => {
  const d = assertDeclaration({ harness: " openclaw ", agent: "main", session: "s1" });
  assert.deepEqual(d, { harness: "openclaw", agent: "main", session: "s1" });
});

test("assertDeclaration: missing agent and session are named", () => {
  assert.throws(
    () => assertDeclaration({ harness: "langgraph" }),
    /identity declaration incomplete \(missing: agent, session\)/
  );
});
test("assertDeclaration: empty strings count as missing", () => {
  assert.throws(
    () => assertDeclaration({ harness: "", agent: "a", session: "s" }),
    /missing: harness/
  );
});
test("assertDeclaration: nothing declared names all three", () => {
  assert.throws(() => assertDeclaration(undefined), /missing: harness, agent, session/);
});

test("declaredFromEnv reads the three env vars", () => {
  const d = declaredFromEnv({ WINCH_HARNESS: "opencode", WINCH_AGENT_ID: "ops", WINCH_SESSION: "main" });
  assert.deepEqual(d, { harness: "opencode", agent: "ops", session: "main" });
});
test("declaredFromEnv throws when the env is incomplete", () => {
  assert.throws(() => declaredFromEnv({ WINCH_HARNESS: "opencode" }), /missing: agent, session/);
});

test("resolveIdentity: meta refines the declaration per layer, sources tagged", () => {
  const id = resolveIdentity({
    base: FULL,
    meta: { winch: { agent: "atlas", session: "ses_42" } },
  });
  assert.equal(id.harness, "langgraph");
  assert.equal(id.agent, "atlas");
  assert.equal(id.session, "ses_42");
  assert.deepEqual(id.source, { harness: "declared", agent: "meta", session: "meta" });
});

test("resolveIdentity: no meta — every layer is the declaration", () => {
  const id = resolveIdentity({ base: FULL });
  assert.deepEqual(id, {
    ...FULL,
    source: { harness: "declared", agent: "declared", session: "declared" },
  });
});

test("resolveIdentity: empty-string meta does not refine", () => {
  const id = resolveIdentity({ base: FULL, meta: { winch: { agent: "" } } });
  assert.equal(id.agent, "planner");
  assert.equal(id.source.agent, "declared");
});

test("resolveIdentity: incomplete base throws even with meta present", () => {
  assert.throws(
    () => resolveIdentity({ base: { harness: "x", agent: "y" }, meta: { winch: { session: "z" } } }),
    /missing: session/
  );
});

test("sessionKey format: harness:agent:session", () => {
  assert.equal(identitySessionKey(FULL), "langgraph:planner:graph-main");
});
