// identity.js — harness declared, agent and session stamped per call.
//
// One thing is declared, two things arrive with the work. The server is
// CONSTRUCTED with the harness it serves (langgraph declares langgraph, the
// openclaw MCP entry declares openclaw); the agent and session of each call
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
 * calling harness stamped on this call (`_meta.winch`). Unstamped,
 * unusable-agent/session calls refuse — the hook layer owns them, not config.
 */
export function resolveIdentity({ meta, base }) {
  const declared = assertDeclaration(base);
  const m = meta?.winch ?? meta ?? null;
  const agent = m?.agent;
  const session = m?.session;
  const bad = [];
  if (!isUsableLayer(agent)) bad.push("agent");
  if (!isUsableLayer(session)) bad.push("session");
  if (bad.length > 0) {
    throw new Error(
      `winch: refused caller identity (unresolved ${bad.join(" and ")}). ` +
        "The calling harness must stamp agent and session on each call — " +
        "the companion plugin does this in its before_tool_call hook, the " +
        "way lineage attributes its per-call costs. Unidentified callers " +
        "fail; they are never given default keys."
    );
  }
  return {
    harness: declared.harness,
    agent: agent.trim(),
    session: session.trim(),
    source: { harness: "declared", agent: "meta", session: "meta" },
  };
}

// Claim key: one slot per harness×agent×session triple. The mint
// point is guarded too, so a key the constructor and resolver both missed
// still fails here — nowhere mints a poisoned key.
export function identitySessionKey(id) {
  const clean = assertCleanTriple(id, "session key");
  return `${clean.harness}:${clean.agent}:${clean.session}`;
}
