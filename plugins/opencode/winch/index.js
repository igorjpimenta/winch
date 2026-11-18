import { createWinchHooks } from "./hooks.js";
import { stampWinchEvent } from "./identity.js";
import { startDispatch, DEFAULT_DISPATCH_URL } from "./dispatch.js";
import { spawn } from "node:child_process";
import { hostname } from "node:os";

// A wake whose agent never exits would hold a full opencode process (and its
// tool subprocesses) forever — one per delivery — so bound each turn and reap
// it on expiry.
const DEFAULT_WAKE_TIMEOUT_MS = 30 * 60 * 1000;

export function createWakeRunner({ logger = console, timeoutMs } = {}) {
  const limit = Number(timeoutMs ?? process.env.WINCH_WAKE_TIMEOUT_MS) || DEFAULT_WAKE_TIMEOUT_MS;
  const children = new Set();

  // Wake children are detached, so each is its own process-group leader; kill
  // the group so the turn's tool and MCP subprocesses die with it.
  const reap = (child) => {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { try { child.kill("SIGKILL"); } catch {} }
  };

  const wake = ({ agent, message }) =>
    new Promise((resolve, reject) => {
      const bin = process.env.OPENCODE_BIN || "opencode";
      const child = spawn(bin, ["run", "--agent", agent, message], {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        // A wake child loads the same config and would start its own dispatch
        // listener, registering as another executor; then every wake fans out
        // into more waking agents. Keep dispatch to the root instance only.
        env: { ...process.env, WINCH_DISPATCH_ENABLED: "0" },
      });
      children.add(child);
      let stderr = "";
      let settled = false;
      let timer;
      const finish = (settle) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        children.delete(child);
        settle();
      };
      child.stderr?.on("data", (d) => { stderr = (stderr + d.toString()).slice(-2000); });
      timer = setTimeout(() => {
        logger?.warn?.(`winch: wake ${message} exceeded ${limit}ms; killing`);
        reap(child);
      }, limit);
      timer.unref?.();
      child.on("error", (err) => finish(() => reject(err)));
      child.on("exit", (code) =>
        finish(() =>
          code === 0 ? resolve() : reject(new Error(`exit ${code}${stderr ? `: ${stderr.trim().split("\n").slice(-2).join(" | ")}` : ""}`))
        )
      );
      child.unref();
    });

  return {
    wake,
    killAll() {
      for (const child of children) reap(child);
      children.clear();
    },
  };
}

function consumerIdFor(harness, cfg = {}) {
  return cfg.winchConsumerId ?? process.env.WINCH_CONSUMER_ID ?? `${harness}:${hostname()}`;
}

function start({ cfg = {}, harness, logger }) {
  const executorId = cfg.winchExecutorId ?? process.env.WINCH_EXECUTOR_ID;
  const consumerId = consumerIdFor(harness, cfg);
  const bearer = process.env.WINCH_WEBHOOK_BEARER;
  if (!executorId || !bearer) {
    logger?.warn?.("winch: dispatch needs WINCH_EXECUTOR_ID and WINCH_WEBHOOK_BEARER; receiver disabled");
    return null;
  }
  const runner = createWakeRunner({ logger, timeoutMs: cfg.wakeTimeoutMs });
  const dispatch = startDispatch({
    baseUrl: process.env.WINCH_DISPATCH_URL ?? DEFAULT_DISPATCH_URL,
    harness,
    consumerId,
    executorId,
    bearer,
    wake: runner.wake,
    port: Number(cfg.dispatchPort ?? process.env.WINCH_DISPATCH_PORT ?? 0),
    reconcileMs: Number(cfg.dispatchReconcileMs ?? process.env.WINCH_DISPATCH_RECONCILE_MS ?? 30000),
    logger,
  });
  dispatch.ready.catch((err) => logger?.warn?.(`winch: dispatch listener failed: ${err?.message ?? err}`));
  const close = dispatch.close.bind(dispatch);
  dispatch.close = async () => { runner.killAll(); await close(); };
  dispatch.killAll = runner.killAll;
  return dispatch;
}

// One package, two hosts: V1 calls server() and gets the object hooks; V2
// reads id/setup() and gets the domain hooks. Both stamp the same identity pair.
export default {
  id: "winch-opencode",
  async setup(ctx) {
    // SessionContext (the "context" hook event) carries both sessionID and
    // the session's agent; session.get() in this beta returns a projection
    // without agent, so the request hook is the reliable source.
    const cfg = ctx.options ?? {};
    const harness = cfg.winchHarness ?? process.env.WINCH_HARNESS ?? "opencode";
    const consumerId = consumerIdFor(harness, cfg);
    const executorId = cfg.winchExecutorId ?? process.env.WINCH_EXECUTOR_ID ?? null;
    const agents = new Map();
    let dispatch = null;
    const ensureDispatch = () => {
      if (dispatch) return;
      if (cfg.dispatchEnabled === false || process.env.WINCH_DISPATCH_ENABLED === "0") return;
      dispatch = start({ cfg, harness, logger: console });
    };
    await ctx.session.hook("context", (event) => {
      if (event?.sessionID && event.agent) agents.set(event.sessionID, event.agent);
      ensureDispatch();
    });
    await ctx.tool.hook("execute.before", (event) => {
      const agent = agents.get(event.sessionID) ?? process.env.WINCH_AGENT ?? null;
      // Unconditional: unknown agent blanks the slot, the server refuses
      // rather than trusting whatever the model wrote there.
      stampWinchEvent(event, agent, consumerId, executorId);
    });
  },
  async server() {
    const harness = process.env.WINCH_HARNESS ?? "opencode";
    const consumerId = consumerIdFor(harness);
    const executorId = process.env.WINCH_EXECUTOR_ID ?? null;
    const hooks = createWinchHooks({ consumerId, instanceId: executorId });
    let dispatch = null;
    const ensureDispatch = () => {
      if (dispatch) return;
      if (process.env.WINCH_DISPATCH_ENABLED === "0") return;
      dispatch = start({ cfg: {}, harness, logger: console });
    };
    const origMessage = hooks["chat.message"];
    hooks["chat.message"] = async (input) => {
      if (typeof origMessage === "function") await origMessage(input);
      ensureDispatch();
    };
    const origParams = hooks["chat.params"];
    hooks["chat.params"] = async (input) => {
      if (typeof origParams === "function") await origParams(input);
      ensureDispatch();
    };
    return hooks;
  },
};
