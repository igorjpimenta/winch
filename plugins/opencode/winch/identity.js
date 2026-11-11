// identity.js — opencode can mutate tool args but not request _meta, so the
// winch server accepts a whole agent+session pair as winch_agent/winch_session
// args (src/identity.js, args channel). The hook overwrites them
// unconditionally: a model-supplied pair must never survive.

export function isWinchTool(name) {
  return typeof name === "string" && name.includes("winch");
}

export function stampWinchIdentity(input, output, { agent = null, usage = null } = {}) {
  if (!isWinchTool(input?.tool)) return false;
  output.args = output.args ?? {};
  // Overwrite, never merge: an unknown agent blanks the slot (unstamped),
  // which the server refuses — that is the fail-closed side of the rule that
  // model-supplied identity never survives.
  output.args.winch_agent = agent ?? "";
  output.args.winch_session = input?.sessionID ?? "";
  if (usage && typeof usage === "object") {
    try { output.args.winch_usage = JSON.stringify(usage); } catch { /* ignore */ }
  }
  return true;
}

// V2: the tool hook hands one mutable event instead of (input, output). Same
// rule — the pair is stamped unconditionally.
export function stampWinchEvent(event, agent, usage = null) {
  if (!isWinchTool(event?.tool)) return false;
  const input = event.input && typeof event.input === "object" ? event.input : {};
  event.input = input;
  input.winch_agent = agent ?? "";
  input.winch_session = event.sessionID ?? "";
  if (usage && typeof usage === "object") {
    try { input.winch_usage = JSON.stringify(usage); } catch { /* ignore */ }
  }
  return true;
}

// Normalize a host-provided usage payload into the shape winch expects.
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {
    model: typeof raw.model === "string" ? raw.model : (typeof raw.modelId === "string" ? raw.modelId : null),
    tokensIn: raw.tokensIn ?? raw.tokens_in ?? raw.inputTokens ?? raw.input_tokens ?? raw.promptTokens ?? null,
    tokensOut: raw.tokensOut ?? raw.tokens_out ?? raw.outputTokens ?? raw.output_tokens ?? raw.completionTokens ?? null,
    cacheRead: raw.cacheRead ?? raw.cache_read ?? raw.cachedTokens ?? raw.cached_tokens ?? null,
    costUsd: raw.costUsd ?? raw.cost_usd ?? raw.cost ?? null,
    toolCalls: raw.toolCalls ?? raw.tool_calls ?? null,
  };
  if (out.model === null && out.tokensIn === null && out.tokensOut === null &&
      out.cacheRead === null && out.costUsd === null && out.toolCalls === null) return null;
  return out;
}
