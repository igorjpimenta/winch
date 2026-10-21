// meta.js — pure before_tool_call identity stamping. No plugin-SDK import,
// so it loads under `node --test` outside the openclaw gateway.

// openclaw exposes MCP tools as mcp__<server>__<tool> (e.g.
// mcp__winch__backlog_next); the substring match survives a prefix change.
export function isWinchTool(name) {
  return typeof name === "string" && name.includes("winch");
}

// sessionKey is the live session; runId is the run that issued the call —
// the same ctx fields browser-lease's ownerFor resolves from. A null
// dimension stays null in the stamp: src/identity.js treats it as a miss and
// refuses the call, so a half-stamped call fails loudly instead of minting a
// default key. With no resolvable dimension at all the hook returns
// undefined and the call proceeds unstamped, for the server to refuse.
export function buildWinchMeta(event, ctx) {
  const toolName = event?.toolName ?? ctx?.toolName;
  if (!isWinchTool(toolName)) return undefined;
  const agent = ctx?.agentId ?? event?.agentId ?? null;
  const session = ctx?.sessionKey ?? ctx?.runId ?? event?.runId ?? null;
  if (agent === null && session === null) return undefined;
  const params = event?.params ?? {};
  return {
    params: {
      ...params,
      _meta: {
        ...(params._meta ?? {}),
        winch: { harness: "openclaw", agent, session },
      },
    },
  };
}
