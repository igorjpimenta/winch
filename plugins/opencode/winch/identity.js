// identity.js — opencode can mutate tool args but not request _meta, so the
// winch server accepts a whole agent+session pair as winch_agent/winch_session
// args (src/identity.js, args channel). The hook overwrites them
// unconditionally: a model-supplied pair must never survive.

export function isWinchTool(name) {
  return typeof name === "string" && name.includes("winch");
}

export function stampWinchIdentity(input, output, { agent = null } = {}) {
  if (!isWinchTool(input?.tool)) return false;
  output.args = output.args ?? {};
  // Overwrite, never merge: an unknown agent blanks the slot (unstamped),
  // which the server refuses — that is the fail-closed side of the rule that
  // model-supplied identity never survives.
  output.args.winch_agent = agent ?? "";
  output.args.winch_session = input?.sessionID ?? "";
  return true;
}

// V2: the tool hook hands one mutable event instead of (input, output). Same
// rule — the pair is stamped unconditionally.
export function stampWinchEvent(event, agent) {
  if (!isWinchTool(event?.tool)) return false;
  const input = event.input && typeof event.input === "object" ? event.input : {};
  event.input = input;
  input.winch_agent = agent ?? "";
  input.winch_session = event.sessionID ?? "";
  return true;
}
