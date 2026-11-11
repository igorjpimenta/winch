// meta.js — pure before_tool_call identity stamping. No plugin-SDK import,
// so it loads under `node --test` outside the openclaw gateway.

// openclaw exposes MCP tools as mcp__<server>__<tool> (e.g.
// mcp__winch__backlog_claim); the substring match survives a prefix change.
export function isWinchTool(name) {
  return typeof name === "string" && name.includes("winch");
}

// Session resolution mirrors the HookContext the host guarantees for bundled
// MCP tool calls since v2026.5.16-beta.7 (oldest compatible stable:
// v2026.5.18, declared in package.json as openclaw.install.minHostVersion).
// Order below is most stable first: the live session key, then the session
// id, then the single-run id, then the same fields off the event. A null dimension stays
// null in the stamp: src/identity.js treats it as a miss and refuses the
// call, so a half-stamped call fails loudly instead of minting a default
// key. With no resolvable dimension at all the hook returns undefined and
// the call proceeds unstamped, for the server to refuse.
export function buildWinchMeta(event, ctx) {
  const toolName = event?.toolName ?? ctx?.toolName;
  if (!isWinchTool(toolName)) return undefined;
  const agent = ctx?.agentId ?? event?.agentId ?? null;
  const session = ctx?.sessionKey ?? ctx?.sessionId ?? ctx?.runId ?? event?.sessionId ?? event?.runId ?? null;
  if (agent === null && session === null) return undefined;
  const params = event?.params ?? {};
  // Optional cost tracking: forward any usage/cost payload the host exposes
  // on the tool context or event. Absent => no usage stamped (winch records
  // nothing), so this stays strictly opt-in.
  const rawUsage = ctx?.usage ?? ctx?.tokens ?? ctx?.cost ??
    event?.usage ?? event?.tokens ?? event?.cost ??
    ctx?.response?.usage ?? event?.response?.usage ?? null;
  const winch = { harness: "openclaw", agent, session };
  if (rawUsage && typeof rawUsage === "object") winch.usage = rawUsage;
  return {
    params: {
      ...params,
      _meta: {
        ...(params._meta ?? {}),
        winch,
      },
    },
  };
}
