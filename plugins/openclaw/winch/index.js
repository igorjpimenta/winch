import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildWinchMeta } from "./meta.js";
import { registerClaimWebhook, registerClaimHeartbeat } from "./webhook.js";
import { autoregister } from "./autoregister.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRouter, defaultStatePath, startDispatchClient, DEFAULT_WS_URL } from "./dispatch.js";

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
      dispatchEnabled: {
        type: "boolean",
        description: "Wake agents from winch events (assignments, appended work, epic reviews). Default true.",
      },
      dispatchWsUrl: {
        type: "string",
        description: "Event stream to follow, e.g. ws://127.0.0.1:38291 (default: that).",
      },
      dispatchPlanner: {
        type: "string",
        description: "Fallback planner for rows without a recorded creator (default: atlas).",
      },
      dispatchStatePath: {
        type: "string",
        description: "File remembering reviewed epics across restarts (default: ~/.openclaw/state/winch-plugin-dispatch.json).",
      },
      dispatchOpenclawBin: {
        type: "string",
        description: "OpenClaw CLI entry used to start a wake session (default: the shim beside the gateway entry).",
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
    let dispatch = null;
    if (typeof api.registerService === "function") {
      api.registerService({
        id: "winch-dispatch",
        start: async () => {
          const cfg = api.pluginConfig ?? {};
          if (cfg.dispatchEnabled === false) {
            api.logger.info("winch: dispatch disabled by config");
            return;
          }
          // scheduleSessionTurn only commits for bundled plugins (the host
          // returns undefined otherwise), so an npm-installed adapter wakes by
          // starting a one-shot agent session through the CLI. The gateway's
          // own argv[1] is the internal dist entry, which has no `agent`
          // subcommand: resolve the package's CLI shim beside it.
          const candidates = [
            cfg.dispatchOpenclawBin,
            path.resolve(path.dirname(process.argv[1] ?? ""), "..", "openclaw.mjs"),
            "/opt/homebrew/bin/openclaw",
          ].filter(Boolean);
          const entry = candidates.find((c) => { try { return existsSync(c); } catch { return false; } }) ?? candidates[0];
          // A wake is a one-shot agent turn carrying nothing but the item id.
          // The child CLI dials back into this gateway, and that connection is
          // occasionally closed while the host is busy (a boot, a heavy turn),
          // so an attempt is retried before the failure is reported.
          const wake = ({ agent, message }) => {
            const tryOnce = () =>
              new Promise((resolve, reject) => {
                const args = [
                  entry,
                  "agent",
                  "--agent", agent,
                  "--session-key", `agent:${agent}:winch:${message}`,
                  "--message", message,
                ];
                // The gateway marks its own env; a child that inherits the
                // service markers exits before doing any work.
                const env = { ...process.env };
                for (const key of [
                  "OPENCLAW_LAUNCHD_LABEL",
                  "OPENCLAW_SERVICE_KIND",
                  "OPENCLAW_SERVICE_MARKER",
                  "OPENCLAW_SERVICE_MANAGED_ENV_KEYS",
                  "OPENCLAW_SYSTEMD_UNIT",
                  "OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER",
                  "OPENCLAW_WINDOWS_TASK_NAME",
                ]) delete env[key];
                const child = spawn(process.execPath, args, {
                  detached: true,
                  stdio: ["ignore", "ignore", "pipe"],
                  env,
                });
                let stderr = "";
                child.stderr?.on("data", (d) => { stderr = (stderr + d.toString()).slice(-2000); });
                child.on("error", reject);
                child.on("exit", (code) =>
                  code === 0 ? resolve() : reject(new Error(`exit ${code}${stderr ? `: ${stderr.trim().split("\n").slice(-2).join(" | ")}` : ""}`))
                );
                child.unref();
              });
            return (async () => {
              let last;
              for (let attempt = 0; attempt < 3; attempt++) {
                try {
                  return await tryOnce();
                } catch (e) {
                  last = e;
                  await new Promise((r) => setTimeout(r, 5000));
                }
              }
              throw last;
            })();
          };
          const router = createRouter({
            planner: cfg.dispatchPlanner ?? "atlas",
            statePath: cfg.dispatchStatePath ?? defaultStatePath(),
            logger: api.logger,
            wake,
          });
          dispatch = startDispatchClient({ url: cfg.dispatchWsUrl ?? DEFAULT_WS_URL, router, logger: api.logger });
        },
        stop: async () => {
          dispatch?.close();
          dispatch = null;
        },
      });
    }
    api.logger.info("winch: registered (identity stamp + claim webhook + dispatch + autoregister)");
  },
});
