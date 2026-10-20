// meta.js — pure before_tool_call identity stamping. No plugin-SDK import,
// so it loads under `node --test` outside the openclaw gateway.

// openclaw exposes MCP tools as mcp__<server>__<tool> (e.g.
// mcp__winch__backlog_next); the substring match survives a prefix change.
export function isWinchTool(name) {
  return typeof name === "string" && name.includes("winch");
}

// sessionKey is the live session; runId is the run that issued the call —
// the same ctx fields browser-lease's ownerFor resolves from. A null
// dimension is "no opinion": the server falls it through to env/fallback
// (src/identity.js treats null as a miss). No resolvable dimension at all
// returns undefined so the call degrades to env instead of fabricated meta.
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
