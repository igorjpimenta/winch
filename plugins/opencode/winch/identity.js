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
  if (agent) output.args.winch_agent = agent;
  if (input?.sessionID) output.args.winch_session = input.sessionID;
  return true;
}
