// winch-meta.js — opencode companion plugin: stamp winch identity args.
//
// Mechanics: tool.execute.before receives {tool, sessionID, callID} plus a
// mutable output.args object (@opencode-ai/plugin types), so args mutation
// reaches the outgoing call. The MCP path never carries _meta — opencode
// dispatches as callTool({ name, arguments: args }), params hold only
// name+arguments — and every MCP input schema is forced
// additionalProperties:false. So instead of _meta, this hook stamps
// winch_agent/winch_session args, which the server declares as optional
// tool fields (see src/mcp.js) and reads when _meta is unreachable.
//
// Trust root: type:local servers spawn over stdio, so the spawning opencode
// process is the sole peer — a stamped value is as unforgeable there as _meta
// is on openclaw's side. The overwrite below is unconditional for the same
// reason the openclaw twin overwrites params._meta: model-supplied values
// must never survive.
//
// One honest limitation: hook input carries no agent dimension ({tool,
// sessionID, callID} only), so every opencode caller shares one agent key
// and sessions do the distinguishing. Concurrent opencode agents contend on
// claims (not_assignee) the way one agent's parallel sessions would — fine
// for single-driver use, visible in the trail either way.
const WINCH_AGENT = "opencode";

function isWinchTool(name) {
  return typeof name === "string" && name.includes("winch");
}

export default {
  id: "winch-meta",
  server: async (input, options) => ({
    "tool.execute.before": async (hookInput, output) => {
      if (!isWinchTool(hookInput?.tool)) return;
      const session = hookInput?.sessionID;
      if (typeof session !== "string" || !session) return;
      const agent =
        typeof options?.agent === "string" && options.agent ? options.agent : WINCH_AGENT;
      output.args = {
        ...(output.args ?? {}),
        winch_agent: agent,
        winch_session: session,
      };
    },
  }),
};
