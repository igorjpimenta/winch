import { stampWinchIdentity } from "./identity.js";

// The agent is not on the tool call, only the session: remember it from the
// chat events that carry both, then stamp the pair on every winch call.
export function createWinchHooks() {
  const agents = new Map();

  return {
    "chat.message": async (input) => {
      if (input?.sessionID && input?.agent) agents.set(input.sessionID, input.agent);
    },
    "chat.params": async (input) => {
      if (input?.sessionID && input?.agent) agents.set(input.sessionID, input.agent);
    },
    "tool.execute.before": async (input, output) => {
      stampWinchIdentity(input, output, { agent: agents.get(input?.sessionID) ?? process.env.WINCH_AGENT });
    },
  };
}
