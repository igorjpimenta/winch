// identity.js — harness declared, agent and session stamped per call.
//
// One thing is declared, two things arrive with the work. The server is
// CONSTRUCTED with the harness it serves (each MCP entry names its own
// consumer); the agent and session of each call
// are the calling harness's job to stamp — via the before_tool_call
// companion plugin — exactly the way lineage attributes per-call cost to an
// agent and a session instead of a configured default.
//
// Nothing here defaults, ever: an unnamed harness refuses construction, and
// an unstamped call refuses execution. A key that cannot say which harness
// and which of its calls it belongs to would poison claims.

// A usable layer names something: non-empty, and neither of the two tokens
// no key may carry ("unknown", "instance:*").
function isUsableLayer(v) {
  return (
    typeof v === "string" &&
    v.trim() !== "" &&
    !/^(unknown|instance:.*)$/i.test(v.trim())
  );
}

/** Throw unless the triple is usable. `who` names the entry point —
 * declaration (construction), resolved identity (per request), caller
 * identity (direct tool entry), session key (the mint itself). */
export function assertCleanTriple(id, who = "identity") {
  const bad = ["harness", "agent", "session"].filter((k) => !isUsableLayer(id?.[k]));
  if (bad.length > 0) {
    throw new Error(`winch: refused ${who} (bad layers: ${bad.join(", ")}). Provide real harness/agent/session values.`);
  }
  return { harness: id.harness.trim(), agent: id.agent.trim(), session: id.session.trim() };
}

/** Declaration = a usable harness, plus the usage line constructors hit.
 * Missing and reserved refuse differently on purpose: the first tells the
 * operator what to add, the second that the value itself can never identify.
 * Both are the same predicate — no separate reserved-token code path. */
export function assertDeclaration(base) {
  const h = typeof base?.harness === "string" ? base.harness.trim() : "";
  if (h === "") {
    throw new Error(
      "winch: identity declaration incomplete (missing: harness). " +
        "Declare the consumer at construction — CLI: WINCH_HARNESS env " +
        "(stdio) / X-Winch-Harness header (HTTP); " +
        "embedders: startMcpServer({ base: { harness } }). " +
        "Agent and session are never declared: they arrive per call."
    );
  }
  if (/^(unknown|instance:.*)$/i.test(h)) {
    throw new Error(
      `winch: refused declaration (reserved: harness). ` +
        `"${h}" cannot identify a consumer — declare the real harness name.`
    );
  }
  return { harness: h };
}

/** Build a declaration from environment variables (the CLI path). */
export function declaredFromEnv(env = process.env) {
  return assertDeclaration({ harness: env.WINCH_HARNESS });
}

/**
 * Per-request identity: the declared harness, plus the agent and session the
 * calling harness stamped on this call. Three trusted channels, in order:
 * `_meta.winch` (a companion with request-params access, e.g. openclaw),
 * `args._meta.winch` (a companion whose output lands inside arguments —
 * same twin, different dispatch shape), `winch_agent`/`winch_session` args
 * (a companion limited to flat args mutation, e.g. opencode — sound only
 * over stdio, where the spawner is the sole peer). The first wholly-usable
 * pair wins; halves never splice across channels. Anything else refuses —
 * the hook layer owns stamping, not config, and unidentified callers are
 * never given keys.
 */
export function resolveIdentity({ meta, args, base }) {
  const declared = assertDeclaration(base);
  const m = meta?.winch ?? meta ?? null;
  const am = args?._meta?.winch ?? null;
  const usable = (v) => (isUsableLayer(v) ? String(v).trim() : null);
  const mAgent = usable(m?.agent), mSession = usable(m?.session);
  const amAgent = usable(am?.agent), amSession = usable(am?.session);
  const aAgent = usable(args?.winch_agent), aSession = usable(args?.winch_session);
  // Whole pairs only: a meta half never splices with an args half, so no
  // call can assemble an identity across trust channels.
  const pair = (mAgent && mSession)
    ? { agent: mAgent, session: mSession, source: "meta" }
    : (amAgent && amSession)
      ? { agent: amAgent, session: amSession, source: "args-meta" }
      : (aAgent && aSession)
        ? { agent: aAgent, session: aSession, source: "args" }
        : null;
  if (!pair) {
    if ((mAgent || amAgent || aAgent) && (mSession || amSession || aSession)) {
      throw new Error(
        "winch: refused caller identity (halves in different channels — pairs never splice). " +
          "Stamp a whole agent+session in one channel: _meta.winch or winch_agent/winch_session args."
      );
    }
    const bad = [];
    if (!mAgent && !amAgent && !aAgent) bad.push("agent");
    if (!mSession && !amSession && !aSession) bad.push("session");
    throw new Error(
      `winch: refused caller identity (unresolved ${bad.join(" and ")}). ` +
        "The calling harness must stamp agent and session on each call — " +
        "via _meta.winch where reachable, else stamped winch_agent/winch_session args. " +
        "Unidentified callers fail; they are never given default keys."
    );
  }
  return {
    harness: declared.harness,
    agent: pair.agent,
    session: pair.session,
    source: { harness: "declared", agent: pair.source, session: pair.source },
  };
}

// Claim key: one slot per harness×agent×session triple. The mint
// point is guarded too, so a key the constructor and resolver both missed
// still fails here — nowhere mints a poisoned key.
export function identitySessionKey(id) {
  const clean = assertCleanTriple(id, "session key");
  return `${clean.harness}:${clean.agent}:${clean.session}`;
}
