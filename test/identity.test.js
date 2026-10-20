// identity.test.js — harness is declared, agent and session arrive per call.
// Construction names a missing or reserved harness; resolution names an
// unstamped or reserved agent/session. Nothing defaults anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertDeclaration, declaredFromEnv, resolveIdentity, identitySessionKey } from "../src/identity.js";

const BASE = { harness: "langgraph" };

test("assertDeclaration: harness passes, extra keys are ignored", () => {
  const d = assertDeclaration({ harness: " openclaw ", agent: "ignored", session: "ignored" });
  assert.deepEqual(d, { harness: "openclaw" });
});

test("assertDeclaration: missing harness throws and names it", () => {
  assert.throws(() => assertDeclaration({ agent: "a", session: "s" }), /missing: harness/);
  assert.throws(() => assertDeclaration(undefined), /missing: harness/);
  assert.throws(() => assertDeclaration({ harness: "  " }), /missing: harness/);
});

test("assertDeclaration: reserved harness throws", () => {
  assert.throws(() => assertDeclaration({ harness: "unknown" }), /refused declaration/);
  assert.throws(() => assertDeclaration({ harness: "instance:4721" }), /refused declaration/);
});

test("declaredFromEnv reads only the harness", () => {
  const d = declaredFromEnv({ WINCH_HARNESS: "opencode", WINCH_AGENT_ID: "x", WINCH_SESSION: "y" });
  assert.deepEqual(d, { harness: "opencode" });
});
test("declaredFromEnv throws without the harness", () => {
  assert.throws(() => declaredFromEnv({}), /missing: harness/);
});

test("resolveIdentity: stamped agent+session complete the declared harness", () => {
  const id = resolveIdentity({
    base: BASE,
    meta: { winch: { agent: "atlas", session: "ses_42" } },
  });
  assert.equal(id.harness, "langgraph");
  assert.equal(id.agent, "atlas");
  assert.equal(id.session, "ses_42");
  assert.deepEqual(id.source, { harness: "declared", agent: "meta", session: "meta" });
});

test("resolveIdentity: meta harness never overrides the declaration", () => {
  const id = resolveIdentity({
    base: BASE,
    meta: { winch: { harness: "evil", agent: "a", session: "s" } },
  });
  assert.equal(id.harness, "langgraph");
});

test("resolveIdentity: no meta — agent and session are unresolved, call refuses", () => {
  assert.throws(() => resolveIdentity({ base: BASE }), /unresolved agent and session/);
});

test("resolveIdentity: partial meta names exactly what's missing", () => {
  assert.throws(
    () => resolveIdentity({ base: BASE, meta: { winch: { agent: "a" } } }),
    /unresolved session/
  );
});

test("resolveIdentity: meta carrying reserved tokens fails instead of minting", () => {
  assert.throws(
    () => resolveIdentity({ base: BASE, meta: { winch: { agent: "UNKNOWN", session: "s" } } }),
    /refused caller identity.*agent/
  );
});

test("resolveIdentity: incomplete base throws even with full meta", () => {
  assert.throws(
    () => resolveIdentity({ base: {}, meta: { winch: { agent: "a", session: "s" } } }),
    /missing: harness/
  );
});

test("sessionKey format: harness:agent:session", () => {
  assert.equal(
    identitySessionKey({ harness: "openclaw", agent: "main", session: "s1" }),
    "openclaw:main:s1"
  );
});

test("identitySessionKey refuses to mint a poisoned key", () => {
  assert.throws(
    () => identitySessionKey({ harness: "x", agent: "unknown", session: "s" }),
    /refused session key.*agent/
  );
});
