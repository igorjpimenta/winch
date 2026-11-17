import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildWinchMeta } from "./meta.js";
import { startDispatch } from "./dispatch.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Mechanics: before_tool_call runs before MCP dispatch, and this hook returns
// a full replacement of event.params with _meta.winch set unconditionally on
// every winch tool call. A call without a resolvable session/agent returns
// undefined and is refused by the server; the model cannot supply identity.
export default definePluginEntry({
  id: "winch",
  name: "Winch",
  description: "Stamps _meta.winch onto winch MCP tool calls, accepts HTTP wake webhooks, and reconciles assigned in-progress work after a gateway restart.",
  configSchema: () => ({
    type: "object",
    additionalProperties: true,
    properties: {
      dispatchEnabled: {
        type: "boolean",
        description: "Accept wake webhooks and reconcile assigned in-progress work. Default true.",
      },
      dispatchUrl: {
        type: "string",
        description: "Winch HTTP base URL, e.g. http://127.0.0.1:38291.",
      },
      dispatchPublicBaseUrl: {
        type: "string",
        description: "Gateway address winch can reach, e.g. http://127.0.0.1:18789. Used to register the wake route.",
      },
      dispatchHarness: {
        type: "string",
        description: "Harness name registered in winch (must match WINCH_HARNESS). Default: openclaw.",
      },
      dispatchReconcileMs: {
        type: "integer",
        description: "Reconcile interval in milliseconds. Default: 30000.",
      },
      dispatchStatePath: {
        type: "string",
        description: "File holding the stable executor id and bearer (default: ~/.openclaw/state/winch-dispatch.json).",
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
    } else {
      api.logger.warn("winch: api.on unavailable; identity hook not registered");
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
          // scheduleSessionTurn only commits for bundled plugins; an npm
          // adapter wakes by starting a one-shot agent session through the CLI.
          // The gateway's own argv[1] is the internal dist entry, which has no
          // `agent` subcommand, so resolve the package's CLI shim beside it.
          const candidates = [
            cfg.dispatchOpenclawBin,
            path.resolve(path.dirname(process.argv[1] ?? ""), "..", "openclaw.mjs"),
            "/opt/homebrew/bin/openclaw",
          ].filter(Boolean);
          const entry = candidates.find((c) => { try { return existsSync(c); } catch { return false; } }) ?? candidates[0];
          const wake = ({ agent, message, sessionKey }) => {
            const tryOnce = () =>
              new Promise((resolve, reject) => {
                const args = [
                  entry,
                  "agent",
                  "--agent", agent,
                  "--session-key", `agent:${agent}:winch:${sessionKey ?? message}`,
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
          dispatch = startDispatch({ api, cfg, wake, logger: api.logger });
        },
        stop: async () => {
          dispatch?.close();
          dispatch = null;
        },
      });
    }
    api.logger.info("winch: registered (identity stamp + HTTP dispatch receiver)");
  },
});
