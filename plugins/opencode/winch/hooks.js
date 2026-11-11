import { stampWinchIdentity } from "./identity.js";
import { normalizeUsage } from "./identity.js";

// The agent is not on the tool call, only the session: remember it from the
// chat events that carry both, then stamp the pair on every winch call.
export function createWinchHooks() {
  const agents = new Map();
  const usage = new Map();

  function captureUsage(sessionID, input) {
    if (!sessionID) return;
    const raw = input?.usage ?? input?.tokens ?? input?.cost ??
      input?.response?.usage ?? input?.message?.usage ?? null;
    const u = normalizeUsage(raw);
    if (u) usage.set(sessionID, u);
  }

  return {
    "chat.message": async (input) => {
      if (input?.sessionID && input?.agent) agents.set(input.sessionID, input.agent);
      captureUsage(input?.sessionID, input);
    },
    "chat.params": async (input) => {
      if (input?.sessionID && input?.agent) agents.set(input.sessionID, input.agent);
      captureUsage(input?.sessionID, input);
    },
    "tool.execute.before": async (input, output) => {
      // Unconditional: when the agent is unknown the slot is blanked, so a
      // model-supplied pair can never ride through as identity. Blank means
      // unstamped, and the server refuses that rather than trusting it.
      const u = input?.sessionID ? usage.get(input.sessionID) ?? null : null;
      // Consume once per turn to avoid double-counting across tool calls.
      if (u && input?.sessionID) usage.delete(input.sessionID);
      stampWinchIdentity(input, output, { agent: agents.get(input?.sessionID) ?? process.env.WINCH_AGENT ?? null, usage: u });
    },
  };
}
