import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildWinchMeta } from "./meta.js";
import { registerClaimWebhook, registerClaimHeartbeat } from "./webhook.js";
import { autoregister } from "./autoregister.js";

// Mechanics: before_tool_call runs before MCP dispatch, and this hook returns
// a full replacement of event.params with _meta.winch set unconditionally on
// every winch tool call — whatever _meta the model supplied is overwritten
// before the request reaches the server, so model-supplied meta cannot
// impersonate an agent. No resolvable session/agent returns undefined; the
// call reaches the server unstamped and is refused — identity has no env
// fallback.
//
// Host floor (>= 2026.5.18, when bundled MCP calls started carrying hook
// session context) is declared in package.json
// (openclaw.install.minHostVersion), enforced by install and registry
// loading — not checked here, by design.
export default definePluginEntry({
  id: "winch",
  name: "Winch",
  description: "Stamps _meta.winch (harness/agent/session) onto winch MCP tool calls so the winch server keys claims to the real caller. Receives claim webhooks and opens a fresh session per attributed task.",
  configSchema: () => ({
    type: "object",
    additionalProperties: true,
    properties: {
      webhookBearer: {
        type: "string",
        description:
          "Shared secret winch must send as Authorization: Bearer on POST /api/winch/claimed. Must match WINCH_CLAIM_WEBHOOK_BEARER. Route stays disarmed (503) until set.",
      },
      webhookPublicBaseUrl: {
        type: "string",
        description:
          "Gateway address winch can reach, e.g. http://127.0.0.1:18789. Used by self-registration to build the route URL.",
      },
      webhookHarness: {
        type: "string",
        description: "Harness name registered in winch (must match WINCH_HARNESS). Default: openclaw.",
      },
      webhookAutoregister: {
        type: "boolean",
        description: "Register the route URL in winch on boot via `winch webhook set` + verify with `test`. Default true when webhookBearer is set.",
      },
      webhookWinchBin: {
        type: "string",
        description: "Winch binary for self-registration (default: WINCH_BIN env or `winch` on PATH). Must share the store the harness claims from.",
      },
    },
  }),
  register: (api) => {
    if (typeof api.on === "function") {
      api.on("before_tool_call", (event, ctx) => buildWinchMeta(event, ctx));
      registerClaimHeartbeat(api);
    } else {
      api.logger.warn("winch: api.on unavailable; identity hook not registered");
    }
    registerClaimWebhook({ api, logger: api.logger });
    if (typeof api.registerService === "function") {
      api.registerService({
        id: "winch-claim-webhook",
        start: async () => {
          await autoregister({ api });
        },
      });
    }
    api.logger.info("winch: registered (identity stamp + claim webhook + autoregister)");
  },
});
