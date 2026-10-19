// identity.test.js — meta > env > fallback resolution per dimension, source
// tags, and the session-key format budgets/claims are keyed by.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveIdentity, identitySessionKey } from "../src/identity.js";

test("meta wins over env and fallback for every dimension, tagged 'meta'", () => {
  const id = resolveIdentity({
    meta: { winch: { harness: "openclaw", agent: "scout", session: "s-1" } },
    env: { WINCH_HARNESS: "env-h", WINCH_AGENT_ID: "env-a", WINCH_SESSION: "env-s" },
    pid: 42,
  });
  assert.equal(id.harness, "openclaw");
  assert.equal(id.agent, "scout");
  assert.equal(id.session, "s-1");
  assert.deepEqual(id.source, { harness: "meta", agent: "meta", session: "meta" });
});

test("env wins over fallback when meta has no opinion, tagged 'env'", () => {
  const id = resolveIdentity({
    meta: {},
    env: { WINCH_HARNESS: "cli", WINCH_AGENT_ID: "lens", WINCH_SESSION: "sess-9" },
    pid: 42,
  });
  assert.equal(id.harness, "cli");
  assert.equal(id.agent, "lens");
  assert.equal(id.session, "sess-9");
  assert.deepEqual(id.source, { harness: "env", agent: "env", session: "env" });
});

test("fallback is unknown / default / instance:<pid>, tagged 'fallback'", () => {
  const id = resolveIdentity({ meta: null, env: {}, pid: 1234 });
  assert.equal(id.harness, "unknown");
  assert.equal(id.agent, "default");
  assert.equal(id.session, "instance:1234");
  assert.deepEqual(id.source, { harness: "fallback", agent: "fallback", session: "fallback" });
});

test("dimensions resolve independently — mixed sources per call", () => {
  const id = resolveIdentity({
    meta: { winch: { agent: "forge" } },
    env: { WINCH_HARNESS: "cron" },
    pid: 7,
  });
  assert.equal(id.harness, "cron");
  assert.equal(id.agent, "forge");
  assert.equal(id.session, "instance:7");
  assert.deepEqual(id.source, { harness: "env", agent: "meta", session: "fallback" });
});

test("a meta object without a winch key is treated as the identity itself", () => {
  const id = resolveIdentity({ meta: { harness: "direct", agent: "herald", session: "s" }, env: {}, pid: 1 });
  assert.equal(id.harness, "direct");
  assert.equal(id.agent, "herald");
  assert.equal(id.session, "s");
  assert.deepEqual(id.source, { harness: "meta", agent: "meta", session: "meta" });
});

test("meta.winch wins over a bare meta shape when both exist", () => {
  const id = resolveIdentity({
    meta: { harness: "bare", agent: "bare-a", winch: { harness: "tagged", agent: "tagged-a" } },
    env: {},
    pid: 1,
  });
  assert.equal(id.harness, "tagged");
  assert.equal(id.agent, "tagged-a");
  assert.deepEqual(id.source, { harness: "meta", agent: "meta", session: "fallback" });
});

test("identitySessionKey is harness:agent:session", () => {
  const id = resolveIdentity({
    meta: { winch: { harness: "test", agent: "scout", session: "s-1" } },
    env: {},
    pid: 99,
  });
  assert.equal(identitySessionKey(id), "test:scout:s-1");
});

test("only null/undefined miss — an explicit empty string is still an opinion", () => {
  const id = resolveIdentity({ meta: { winch: { harness: "", agent: "", session: "" } }, env: { WINCH_AGENT_ID: "env-a" }, pid: 5 });
  assert.equal(id.harness, "");
  assert.equal(id.agent, "");
  assert.equal(id.session, "");
  assert.deepEqual(id.source, { harness: "meta", agent: "meta", session: "meta" });
  const id2 = resolveIdentity({ meta: null, env: { WINCH_AGENT_ID: "env-a" }, pid: 5 });
  assert.equal(id2.agent, "env-a");
  assert.equal(id2.source.agent, "env");
});
