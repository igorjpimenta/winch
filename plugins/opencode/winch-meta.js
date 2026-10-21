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
// Identity therefore has no per-call channel on opencode. The MCP entry can
// declare the harness (WINCH_HARNESS=opencode), but agent and session must be
// stamped per call and this hook cannot reach request params. Unstamped calls
// are refused rather than attributed to a configured default, so opencode
// uses winch read-only until a meta-capable hook exists.
//
// The export stays a registered no-op so the hook point exists for an
// opencode version that grows request-level meta mutation; see plugins/README.
export default {
  id: "winch-meta",
  server: async () => ({}),
};
