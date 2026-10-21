// winch-meta.js — opencode companion plugin for winch identity.
//
// Mechanics: opencode's tool.execute.before mutates the shared output.args
// object (@opencode-ai/plugin dist/index.d.ts: input {tool, sessionID,
// callID} → output {args}, return Promise<void> — no return-value channel),
// so args mutation in general reaches the outgoing call. The MCP path,
// however, never carries _meta: opencode invokes the server as
// callTool({ name, arguments: args }) — params hold only name+arguments,
// there is no params._meta slot — and every MCP input schema is forced
// additionalProperties:false, so an args._meta key is stripped or rejected
// before the wire. The winch server reads extra._meta (request params._meta;
// src/mcp.js), which this hook cannot reach.
//
// Identity therefore travels the env channel on the MCP server entry —
// WINCH_HARNESS=opencode, WINCH_AGENT_ID=<agent> — with session degrading
// server-side to instance:<pid> (one MCP process per opencode instance).
// Env is operator configuration, not model-controlled per-call input, so the
// overwrite property a hook-based adapter gets holds here by construction.
//
// The export stays a registered no-op so the hook point exists for an
// opencode version that grows request-level meta mutation; see plugins/README.
export default {
  id: "winch-meta",
  server: async () => ({}),
};
