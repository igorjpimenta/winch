import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildWinchMeta } from "./meta.js";
import { startDispatch, DEFAULT_DISPATCH_URL } from "./dispatch.js";
import { remember, reportReplyUsage } from "./usage.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
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
      dispatchPublicBaseUrl: {
        type: "string",
        description: "Gateway address winch can reach, e.g. http://127.0.0.1:18789. Used to register the wake route.",
      },
      winchHarness: {
        type: "string",
        description: "Harness name for identity and dispatch (must match WINCH_HARNESS). Default: openclaw.",
      },
      winchExecutorId: {
        type: "string",
        description: "Unique executor id for this connection. Default: WINCH_EXECUTOR_ID.",
      },
      winchConsumerId: {
        type: "string",
        description: "Stable consumer id shared by this gateway's executors. Default: harness:hostname.",
      },
      dispatchReconcileMs: {
        type: "integer",
        description: "Reconcile interval in milliseconds. Default: 30000.",
      },
      dispatchOpenclawBin: {
        type: "string",
        description: "OpenClaw CLI entry used to start a wake session (default: the shim beside the gateway entry).",
      },
    },
  }),
  register: (api) => {
    const cfg = api.pluginConfig ?? {};
    const harness = cfg.winchHarness ?? process.env.WINCH_HARNESS ?? "openclaw";
    const consumerId = cfg.winchConsumerId ?? process.env.WINCH_CONSUMER_ID ?? `${harness}:${hostname()}`;
    const executorId = cfg.winchExecutorId ?? process.env.WINCH_EXECUTOR_ID ?? null;
    // Only sessions that have made a winch call are bound to an item, so only
    // those carry usage the server can attribute.
    const engaged = new Set();
    if (typeof api.on === "function") {
      api.on("before_tool_call", (event, ctx) => {
        const stamp = buildWinchMeta(event, ctx, harness, consumerId, executorId);
        if (stamp) remember(engaged, stamp.params._meta.winch.session);
        return stamp;
      });
      // One usage snapshot per run arrives on reply_payload_sending. The hook
      // returns nothing so the payload is delivered unchanged.
      api.on("reply_payload_sending", (event) => {
        const session = event?.sessionKey ?? event?.usageState?.sessionId ?? event?.runId;
        if (!engaged.has(session)) return;
        reportReplyUsage({
          event,
          harness,
          baseUrl: process.env.WINCH_DISPATCH_URL ?? DEFAULT_DISPATCH_URL,
          token: process.env.WINCH_DISPATCH_TOKEN,
          logger: api.logger,
        });
      });
    } else {
      api.logger.warn("winch: api.on unavailable; identity and usage hooks not registered");
    }

    let dispatch = null;
    if (typeof api.registerService === "function") {
      api.registerService({
        id: "winch-dispatch",
        start: async () => {
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
          dispatch = startDispatch({ api, cfg, harness, wake, logger: api.logger });
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
