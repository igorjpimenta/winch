// identity.js — three identity dimensions (harness, agent, session) resolved
// from the first source that has an opinion, each tagged with where it came
// from. Resolution order meta > env > fallback:
//
//   meta — `_meta.winch` on the MCP request. Companion plugins write it by
//          overwriting unconditionally, so a model-supplied `_meta` cannot
//          impersonate a harness/agent/session it does not control.
//   env  — WINCH_HARNESS / WINCH_AGENT_ID / WINCH_SESSION, covering plain
//          MCP clients that set no meta.
//   fallback — per-process instance key (`instance:<pid>`), so budgets stay
//          per-process even when nothing else is configured.
//
// The session key is the budget/claim identity; it must be derived from the
// binding, never from tool params, or agents could claim under each other's
// names.

/**
 * @param {{meta?: object, env?: object, pid?: number}} [opts]
 * @returns {{harness: string, agent: string, session: string,
 *            source: {harness: "meta"|"env"|"fallback", agent: "meta"|"env"|"fallback", session: "meta"|"env"|"fallback"}}}
 */
export function resolveIdentity({ meta, env = process.env, pid = process.pid } = {}) {
  const m = meta?.winch ?? meta ?? null;

  function pick(mVal, envVal, fallbackVal) {
    if (mVal !== undefined && mVal !== null) return { value: String(mVal), source: "meta" };
    if (envVal !== undefined && envVal !== null) return { value: String(envVal), source: "env" };
    return { value: fallbackVal, source: "fallback" };
  }

  const harness = pick(m?.harness, env.WINCH_HARNESS, "unknown");
  const agent   = pick(m?.agent,   env.WINCH_AGENT_ID, "default");
  const session = pick(m?.session, env.WINCH_SESSION, `instance:${pid}`);

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
