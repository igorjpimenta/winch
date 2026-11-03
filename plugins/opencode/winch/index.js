import { createWinchHooks } from "./hooks.js";
import { stampWinchEvent } from "./identity.js";

// One package, two hosts: V1 calls server() and gets the object hooks; V2
// reads id/setup() and gets the domain hooks. The implementations stay
// separate — V1 mutates (input, output), V2 mutates one event — but both
// stamp the same unconditional identity pair.
export default {
  id: "winch-opencode",
  async setup(ctx) {
    // SessionContext (the "context" hook event) carries both sessionID and
      // the session's agent; session.get() in this beta returns a projection
      // without agent, so the request hook is the reliable source.
      const agents = new Map();
      await ctx.session.hook("context", (event) => {
      if (event?.sessionID && event.agent) agents.set(event.sessionID, event.agent);
    });
    await ctx.tool.hook("execute.before", (event) => {
      const agent = agents.get(event.sessionID) ?? process.env.WINCH_AGENT ?? null;
      // Unconditional: unknown agent blanks the slot, the server refuses
      // rather than trusting whatever the model wrote there.
      stampWinchEvent(event, agent);
    });
  },
  async server() {
    return createWinchHooks();
  },
};
