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
        "Declare the consumer at construction — CLI: --harness / WINCH_HARNESS; " +
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
 * calling harness stamped on this call. Two trusted channels, in order:
 * `_meta.winch` (a companion with request-params access, e.g. openclaw),
 * else stamped tool args `winch_agent`/`winch_session` (a companion limited
 * to args mutation, e.g. opencode — sound only over stdio, where the spawner
 * is the sole peer). Meta wins wholesale or not at all: halves are never
 * spliced across channels. Anything else refuses — the hook layer owns
 * stamping, not config, and unidentified callers are never given keys.
 */
export function resolveIdentity({ meta, args, base }) {
  const declared = assertDeclaration(base);
  const m = meta?.winch ?? meta ?? null;
  const mAgent = isUsableLayer(m?.agent) ? m.agent.trim() : null;
  const mSession = isUsableLayer(m?.session) ? m.session.trim() : null;
  const aAgent = isUsableLayer(args?.winch_agent) ? String(args.winch_agent).trim() : null;
  const aSession = isUsableLayer(args?.winch_session) ? String(args.winch_session).trim() : null;
  // Whole pairs only: a meta half never splices with an args half, so no
  // call can assemble an identity across trust channels.
  const pair = (mAgent && mSession)
    ? { agent: mAgent, session: mSession, source: "meta" }
    : (aAgent && aSession)
      ? { agent: aAgent, session: aSession, source: "args" }
      : null;
  if (!pair) {
    if ((mAgent || aAgent) && (mSession || aSession)) {
      throw new Error(
        "winch: refused caller identity (halves in different channels — pairs never splice). " +
          "Stamp a whole agent+session in one channel: _meta.winch or winch_agent/winch_session args."
      );
    }
    const bad = [];
    if (!mAgent && !aAgent) bad.push("agent");
    if (!mSession && !aSession) bad.push("session");
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
