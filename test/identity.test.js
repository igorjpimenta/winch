// identity.test.js — harness is declared, agent and session arrive per call.
// Construction names a missing or reserved harness; resolution names an
// unstamped or reserved agent/session. Nothing defaults anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertDeclaration, declaredFromEnv, resolveIdentity, identitySessionKey } from "../src/identity.js";

const BASE = { harness: "langgraph" };

test("assertDeclaration: harness passes, extra keys are ignored", () => {
  const d = assertDeclaration({ harness: " test-harness ", agent: "ignored", session: "ignored" });
  assert.deepEqual(d, { harness: "test-harness" });
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

test("resolveIdentity: empty-string meta is unstamped, not an identity", () => {
  assert.throws(
    () => resolveIdentity({ base: { harness: "langgraph" }, meta: { winch: { agent: "", session: "" } } }),
    /unresolved agent and session/
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
    identitySessionKey({ harness: "test-harness", agent: "main", session: "s1" }),
    "test-harness:main:s1"
  );
});

test("identitySessionKey refuses to mint a poisoned key", () => {
  assert.throws(
    () => identitySessionKey({ harness: "x", agent: "unknown", session: "s" }),
    /refused session key.*agent/
  );
});

test("resolveIdentity: stamped args complete identity when meta is absent (opencode path)", () => {
  const id = resolveIdentity({
    base: BASE,
    args: { taskId: "TASK-1", winch_agent: "opencode", winch_session: "ses-9" },
  });
  assert.equal(id.harness, "langgraph");
  assert.equal(id.agent, "opencode");
  assert.equal(id.session, "ses-9");
  assert.deepEqual(id.source, { harness: "declared", agent: "args", session: "args" });
});

test("resolveIdentity: meta wins wholesale — halves never splice across channels", () => {
  const id = resolveIdentity({
    base: BASE,
    meta: { winch: { agent: "atlas", session: "ses_42" } },
    args: { winch_agent: "mallory", winch_session: "ses_evil" },
  });
  assert.equal(id.agent, "atlas");
  assert.equal(id.session, "ses_42");
  assert.deepEqual(id.source, { harness: "declared", agent: "meta", session: "meta" });
});

test("resolveIdentity: partial meta falls back to whole args pair, else refuses precisely", () => {
  const id = resolveIdentity({
    base: BASE,
    meta: { winch: { agent: "atlas" } },
    args: { winch_agent: "opencode", winch_session: "ses-9" },
  });
  assert.equal(id.agent, "opencode", "half-meta yields to a whole args pair, not a splice");
  assert.throws(
    () => resolveIdentity({ base: BASE, meta: { winch: { agent: "atlas" } }, args: { winch_session: "s" } }),
    /pairs never splice/,
    "halves across channels refuse loudly instead of splicing or crashing"
  );
  assert.throws(
    () => resolveIdentity({ base: BASE, args: { winch_agent: "unknown", winch_session: "s" } }),
    /unresolved agent/,
    "reserved tokens in args refuse like reserved tokens in meta"
  );
});

test("resolveIdentity: args._meta.winch pair attributes (hook output landed in arguments)", () => {
  const id = resolveIdentity({
    base: BASE,
    args: { taskId: "TASK-1", _meta: { winch: { agent: "scout", session: "ses-7" } } },
  });
  assert.equal(id.agent, "scout");
  assert.equal(id.session, "ses-7");
  assert.deepEqual(id.source, { harness: "declared", agent: "args-meta", session: "args-meta" });
});

test("resolveIdentity: precedence is params-meta, then args-meta, then flat args", () => {
  const id = resolveIdentity({
    base: BASE,
    meta: { winch: { agent: "atlas", session: "ses_42" } },
    args: { _meta: { winch: { agent: "x", session: "y" } }, winch_agent: "z", winch_session: "w" },
  });
  assert.equal(id.agent, "atlas");
  assert.deepEqual(id.source, { harness: "declared", agent: "meta", session: "meta" });
  const id2 = resolveIdentity({
    base: BASE,
    args: { _meta: { winch: { agent: "scout", session: "s" } }, winch_agent: "z", winch_session: "w" },
  });
  assert.equal(id2.agent, "scout");
  assert.deepEqual(id2.source, { harness: "declared", agent: "args-meta", session: "args-meta" });
});

test("resolveIdentity: partial args-meta never splices with flat halves", () => {
  assert.throws(
    () => resolveIdentity({
      base: BASE,
      args: { _meta: { winch: { agent: "scout" } }, winch_session: "s" },
    }),
    /pairs never splice/
  );
  assert.throws(
    () => resolveIdentity({ base: BASE, args: { _meta: { winch: { agent: "unknown", session: "s" } } } }),
    /unresolved agent/
  );
});
