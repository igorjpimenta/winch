import { stampWinchIdentity } from "./identity.js";
import { isFinalAssistant, remember, reportAssistantUsage } from "./usage.js";

// The agent is not on the tool call, only the session: remember it from the
// chat events that carry both, then stamp the pair on every winch call.
export function createWinchHooks({ consumerId = null, instanceId = null, harness = "opencode", logger = console } = {}) {
  const agents = new Map();
  const reported = new Set();
  // Usage is reported only for sessions that have made a winch call, which is
  // when the session is bound to an item the server can attribute it to.
  const engaged = new Set();

  return {
    "chat.message": async (input) => {
      if (input?.sessionID && input?.agent) agents.set(input.sessionID, input.agent);
    },
    "chat.params": async (input) => {
      if (input?.sessionID && input?.agent) agents.set(input.sessionID, input.agent);
    },
    "tool.execute.before": async (input, output) => {
      // Unconditional: when the agent is unknown the slot is blanked, so a
      // model-supplied pair can never ride through as identity. Blank means
      // unstamped, and the server refuses that rather than trusting it.
      const stamped = stampWinchIdentity(input, output, { agent: agents.get(input?.sessionID) ?? process.env.WINCH_AGENT ?? null, consumerId, instanceId });
      if (stamped) remember(engaged, input?.sessionID);
    },
    // A final assistant message carries the turn's cost and token snapshot.
    event: async ({ event } = {}) => {
      if (event?.type !== "message.updated") return;
      const info = event.properties?.info;
      if (!engaged.has(info?.sessionID) || !isFinalAssistant(info) || !remember(reported, info.id)) return;
      const agent = agents.get(info?.sessionID) ?? info?.agent ?? process.env.WINCH_AGENT ?? null;
      reportAssistantUsage({ info, harness, agent, logger });
    },
  };
}
