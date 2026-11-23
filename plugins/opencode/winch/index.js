import { createWinchHooks } from "./hooks.js";
import { stampWinchEvent } from "./identity.js";
import { startDispatch, DEFAULT_DISPATCH_URL } from "./dispatch.js";
import { isFinalAssistant, remember, reportAssistantUsage } from "./usage.js";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os, { hostname } from "node:os";
import path from "node:path";

// A wake child is orphaned only when the process that spawned it is gone. A
// child whose owner is still running is doing real work, so it must not be
// reaped. The sweep therefore kills nothing except leftovers from a dead owner.
const SWEEP_MS = 60 * 1000;

function wakeStateDir() {
  return path.join(os.homedir(), ".opencode", "state", "winch-wakes");
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err?.code === "EPERM"; }
}

function processCommand(pid) {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function createWakeRunner({ logger = console, stateDir = wakeStateDir() } = {}) {
  // Detached children lead their own process group; kill the group so a
  // reaped turn's tool and MCP subprocesses go with it.
  const reap = (pid) => {
    try { process.kill(-pid, "SIGKILL"); }
    catch { try { process.kill(pid, "SIGKILL"); } catch {} }
  };

  const recordPath = (ownerPid, childPid) => path.join(stateDir, `wake-${ownerPid}-${childPid}.json`);

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
      const file = child.pid ? recordPath(process.pid, child.pid) : null;
      if (file) {
        try {
          mkdirSync(stateDir, { recursive: true });
          writeFileSync(file, JSON.stringify({ pid: child.pid, ownerPid: process.pid, agent, message }));
        } catch (err) {
          logger?.warn?.(`winch: wake record not written: ${err?.message ?? err}`);
        }
      }
      const forget = () => { try { if (file) unlinkSync(file); } catch {} };
      let stderr = "";
      child.stderr?.on("data", (d) => { stderr = (stderr + d.toString()).slice(-2000); });
      child.on("error", (err) => { forget(); reject(err); });
      child.on("exit", (code) => {
        forget();
        code === 0 ? resolve() : reject(new Error(`exit ${code}${stderr ? `: ${stderr.trim().split("\n").slice(-2).join(" | ")}` : ""}`));
      });
      // Unref: an agent run must not hold its caller's event loop open, or a
      // daemon could not shut down while a wake is in flight. A caller that
      // awaits wake() must therefore keep its own handle alive — the exit
      // event will not dispatch on an otherwise empty loop.
      child.unref();
    });

  // Kill wake children whose spawning owner is no longer alive. Called at
  // dispatch startup and on a sweep timer; never on close, because a child
  // still owned by a live instance is not an orphan.
  function reapOrphans() {
    let names = [];
    try { names = readdirSync(stateDir); } catch { return 0; }
    let killed = 0;
    for (const name of names) {
      if (!name.startsWith("wake-") || !name.endsWith(".json")) continue;
      const file = path.join(stateDir, name);
      let entry;
      try { entry = JSON.parse(readFileSync(file, "utf8")); }
      catch { try { unlinkSync(file); } catch {} continue; }
      if (!entry?.pid || !entry?.ownerPid) { try { unlinkSync(file); } catch {} continue; }
      if (pidAlive(entry.ownerPid)) continue; // owner alive: not an orphan
      if (pidAlive(entry.pid)) {
        // Guard PID reuse: only kill a process still running this wake's
        // command, never whatever now occupies the recycled pid.
        const cmd = processCommand(entry.pid);
        if (cmd.includes("--agent") && entry.message && cmd.includes(entry.message)) {
          reap(entry.pid);
          killed += 1;
        }
      }
      try { unlinkSync(file); } catch {}
    }
    if (killed) logger?.warn?.(`winch: reaped ${killed} orphaned wake(s)`);
    return killed;
  }

  return { wake, reapOrphans };
}

function consumerIdFor(harness, cfg = {}) {
  return cfg.winchConsumerId ?? process.env.WINCH_CONSUMER_ID ?? `${harness}:${hostname()}`;
}

function start({ cfg = {}, harness, logger }) {
  const runner = createWakeRunner({ logger, stateDir: cfg.wakeStateDir });
  runner.reapOrphans();

  const executorId = cfg.winchExecutorId ?? process.env.WINCH_EXECUTOR_ID;
  const consumerId = consumerIdFor(harness, cfg);
  const bearer = process.env.WINCH_WEBHOOK_BEARER;
  if (!executorId || !bearer) {
    logger?.warn?.("winch: dispatch needs WINCH_EXECUTOR_ID and WINCH_WEBHOOK_BEARER; receiver disabled");
    return null;
  }
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

  const sweep = setInterval(() => runner.reapOrphans(), Number(cfg.wakeSweepMs ?? SWEEP_MS));
  sweep.unref?.();
  const close = dispatch.close.bind(dispatch);
  dispatch.close = async () => { clearInterval(sweep); await close(); };
  dispatch.reapOrphans = runner.reapOrphans;
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
    const reported = new Set();
    const engaged = new Set();
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
      if (stampWinchEvent(event, agent, consumerId, executorId)) remember(engaged, event.sessionID);
    });
    if (typeof ctx.event?.subscribe === "function") {
      const controller = new AbortController();
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ types: ["message.updated"], signal: controller.signal })) {
            if (event?.type !== "message.updated") continue;
            const info = event.properties?.info;
            if (!engaged.has(info?.sessionID) || !isFinalAssistant(info) || !remember(reported, info.id)) continue;
            const agent = agents.get(info?.sessionID) ?? info?.agent ?? process.env.WINCH_AGENT ?? null;
            reportAssistantUsage({ info, harness, agent, logger: console });
          }
        } catch { /* subscription closed */ }
      })();
      return () => controller.abort();
    }
  },
  async server() {
    const harness = process.env.WINCH_HARNESS ?? "opencode";
    const consumerId = consumerIdFor(harness);
    const executorId = process.env.WINCH_EXECUTOR_ID ?? null;
    const hooks = createWinchHooks({ consumerId, instanceId: executorId, harness, logger: console });
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
