import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildWinchMeta } from "./meta.js";

// Mechanics: before_tool_call runs before MCP dispatch, and this hook returns
// a full replacement of event.params with _meta.winch set unconditionally on
// every winch tool call — whatever _meta the model supplied is overwritten
// before the request reaches the server, so model-supplied meta cannot
// impersonate an agent. No resolvable session/agent returns undefined; the
// call reaches the server unstamped and is refused — identity has no env
// fallback.
export default definePluginEntry({
  id: "winch-meta",
  name: "Winch Meta",
  description: "Stamps _meta.winch (harness/agent/session) onto winch MCP tool calls so the winch server keys claims to the real caller.",
  configSchema: () => ({}),
  register: (api) => {
    if (typeof api.on !== "function") {
      api.logger.warn("winch-meta: api.on unavailable; not registering hook");
      return;
    }
    api.on("before_tool_call", (event, ctx) => buildWinchMeta(event, ctx));
    api.logger.info("winch-meta: registered (stamps _meta.winch on winch MCP tool calls)");
  },
});
