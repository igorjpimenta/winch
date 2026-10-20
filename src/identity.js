// identity.js — the three identity dimensions (harness, agent, session).
//
// The three-part key is required, not defaulted: every winch MCP server is
// CONSTRUCTED with a declared triple — the consumer's identity (langgraph
// declares langgraph, openclaw declares openclaw, a test harness declares
// itself). Startup fails when any layer is missing; there is no "unknown" or
// instance-pid fallback to hide an undeclared consumer, because an unnamed
// key poisons claim attribution and the budget ledger.
//
//   declaration — {harness, agent, session} at construction. For the CLI:
//                 --harness/--agent/--session flags or WINCH_HARNESS /
//                 WINCH_AGENT_ID / WINCH_SESSION env. For embedders: the
//                 `base` option of startMcpServer. The declaration is the
//                 floor every request starts from.
//   meta — `_meta.winch` on the MCP request. Companion plugins write it by
//          overwriting unconditionally, so a model-supplied `_meta` cannot
//          impersonate a harness/agent/session it does not control. Meta
//          refines individual layers of the declared floor (openclaw stamps
//          the real agent and session per call over its declaration).
//
// The session key is the budget/claim identity; it is derived from the
// binding, never from tool params, or agents could claim under each other's
// names.

/** Throw unless {harness, agent, session} are all non-empty strings. */
export function assertDeclaration(base) {
  const missing = ["harness", "agent", "session"].filter(
    (k) => typeof base?.[k] !== "string" || base[k].trim() === ""
  );
  if (missing.length > 0) {
    throw new Error(
      `winch: identity declaration incomplete (missing: ${missing.join(", ")}). ` +
        "All three layers are required at construction — CLI: --harness/--agent/--session " +
        "flags or WINCH_HARNESS/WINCH_AGENT_ID/WINCH_SESSION; embedders: " +
        "startMcpServer({ base: { harness, agent, session } })."
    );
  }
  return { harness: base.harness.trim(), agent: base.agent.trim(), session: base.session.trim() };
}

/** Build a declaration from environment variables (the CLI path). */
export function declaredFromEnv(env = process.env) {
  return assertDeclaration({
    harness: env.WINCH_HARNESS,
    agent: env.WINCH_AGENT_ID,
    session: env.WINCH_SESSION,
  });
}

/**
 * Per-request identity: meta refines the declaration layer by layer.
 * @param {{meta?: object, base: {harness: string, agent: string, session: string}}} opts
 */
export function resolveIdentity({ meta, base }) {
  const declared = assertDeclaration(base);
  const m = meta?.winch ?? meta ?? null;

  function pick(metaVal, declaredVal) {
    if (metaVal !== undefined && metaVal !== null && String(metaVal) !== "") {
      return { value: String(metaVal), source: "meta" };
    }
    return { value: declaredVal, source: "declared" };
  }

  const harness = pick(m?.harness, declared.harness);
  const agent = pick(m?.agent, declared.agent);
  const session = pick(m?.session, declared.session);

  return {
    harness: harness.value,
    agent: agent.value,
    session: session.value,
    source: { harness: harness.source, agent: agent.source, session: session.source },
  };
}

/** Budget/claim key: one slot per harness×agent×session triple. */
export function identitySessionKey(id) {
  return `${id.harness}:${id.agent}:${id.session}`;
}
