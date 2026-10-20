// identity.test.js — the three-layer key is a construction requirement:
// complete declarations pass, incomplete ones throw by name, and per-request
// meta refines the declaration layer by layer with tagged sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertDeclaration, declaredFromEnv, resolveIdentity, identitySessionKey , assertCleanTriple } from "../src/identity.js";

const FULL = { harness: "langgraph", agent: "planner", session: "graph-main" };

test("assertDeclaration: complete triple passes and trims", () => {
  const d = assertDeclaration({ harness: " openclaw ", agent: "main", session: "s1" });
  assert.deepEqual(d, { harness: "openclaw", agent: "main", session: "s1" });
});

test("assertDeclaration: unusable agent and session are named", () => {
  assert.throws(
    () => assertDeclaration({ harness: "langgraph" }),
    /refused declaration \(bad layers: agent, session\)/
  );
});
test("assertDeclaration: empty strings count as missing", () => {
  assert.throws(
    () => assertDeclaration({ harness: "", agent: "a", session: "s" }),
    /bad layers: harness/
  );
});
test("assertDeclaration: nothing declared names all three", () => {
  assert.throws(() => assertDeclaration(undefined), /bad layers: harness, agent, session/);
});

test("declaredFromEnv reads the three env vars", () => {
  const d = declaredFromEnv({ WINCH_HARNESS: "opencode", WINCH_AGENT_ID: "ops", WINCH_SESSION: "main" });
  assert.deepEqual(d, { harness: "opencode", agent: "ops", session: "main" });
});
test("declaredFromEnv throws when the env is incomplete", () => {
  assert.throws(() => declaredFromEnv({ WINCH_HARNESS: "opencode" }), /bad layers: agent, session/);
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
    /bad layers: session/
  );
});

test("sessionKey format: harness:agent:session", () => {
  assert.equal(identitySessionKey(FULL), "langgraph:planner:graph-main");
});

test("assertDeclaration: reserved tokens fail — unknown and instance:* are not keys", () => {
  assert.throws(
    () => assertDeclaration({ harness: "unknown", agent: "a", session: "s" }),
    /bad layers: harness/
  );
  assert.throws(
    () => assertDeclaration({ harness: "x", agent: "UNKNOWN", session: "s" }),
    /bad layers: agent/
  );
  assert.throws(
    () => assertDeclaration({ harness: "x", agent: "a", session: "instance:4721" }),
    /bad layers: session/
  );
});

test("resolveIdentity: meta carrying a reserved token fails instead of minting", () => {
  assert.throws(
    () => resolveIdentity({ base: { harness: "opencode", agent: "main", session: "s1" }, meta: { winch: { harness: "UNKNOWN" } } }),
    /refused resolved identity.*harness/
  );
});

test("identitySessionKey refuses to mint a poisoned key", () => {
  assert.throws(
    () => identitySessionKey({ harness: "x", agent: "unknown", session: "s" }),
    /refused session key.*agent/
  );
});
