import { createWinchHooks } from "./hooks.js";
import { stampWinchEvent } from "./identity.js";
import { createRouter, defaultStatePath, startDispatchClient, DEFAULT_WS_URL } from "./dispatch.js";
import { spawn } from "node:child_process";

function startDispatch({ url, planner, maxConcurrent, statePath, logger }) {
  const wake = ({ agent, message }) =>
    new Promise((resolve, reject) => {
      const bin = process.env.OPENCODE_BIN || "opencode";
      const child = spawn(bin, ["run", "--agent", agent, message], {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (d) => { stderr = (stderr + d.toString()).slice(-2000); });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`exit ${code}${stderr ? `: ${stderr.trim().split("\n").slice(-2).join(" | ")}` : ""}`))
      );
      child.unref();
    });
  const router = createRouter({
    wake,
    planner: planner ?? null,
    maxConcurrent: maxConcurrent ?? 8,
    statePath: statePath ?? defaultStatePath(),
    logger: logger ?? console,
  });
  return startDispatchClient({ url: url ?? DEFAULT_WS_URL, router, logger: logger ?? console });
}

// One package, two hosts: V1 calls server() and gets the object hooks; V2
// reads id/setup() and gets the domain hooks. The implementations stay
// separate — V1 mutates (input, output), V2 mutates one event — but both
// stamp the same unconditional identity pair. Dispatch starts lazily on the
// first session activity so importing the module (and the test suite) never
// opens a socket.
export default {
  id: "winch-opencode",
  async setup(ctx) {
    // SessionContext (the "context" hook event) carries both sessionID and
      // the session's agent; session.get() in this beta returns a projection
      // without agent, so the request hook is the reliable source.
      const agents = new Map();
      let dispatch = null;
      const ensureDispatch = () => {
        if (dispatch) return;
        const cfg = ctx.options ?? {};
        if (cfg.dispatchEnabled === false) return;
        dispatch = startDispatch({
          url: cfg.dispatchWsUrl ?? DEFAULT_WS_URL,
          planner: cfg.dispatchPlanner ?? null,
          maxConcurrent: cfg.dispatchMaxConcurrent ?? Number(process.env.WINCH_DISPATCH_MAX_CONCURRENT ?? 8),
          statePath: cfg.dispatchStatePath ?? defaultStatePath(),
          logger: console,
        });
      };
      await ctx.session.hook("context", (event) => {
      if (event?.sessionID && event.agent) agents.set(event.sessionID, event.agent);
      ensureDispatch();
    });
    await ctx.tool.hook("execute.before", (event) => {
      const agent = agents.get(event.sessionID) ?? process.env.WINCH_AGENT ?? null;
      // Unconditional: unknown agent blanks the slot, the server refuses
      // rather than trusting whatever the model wrote there.
      stampWinchEvent(event, agent);
    });
  },
  async server() {
    const hooks = createWinchHooks();
    let dispatch = null;
    const ensureDispatch = () => {
      if (dispatch) return;
      if (process.env.WINCH_DISPATCH_ENABLED === "0") return;
      dispatch = startDispatch({
        url: process.env.WINCH_DISPATCH_WS_URL ?? DEFAULT_WS_URL,
        planner: process.env.WINCH_DISPATCH_PLANNER ?? null,
        maxConcurrent: Number(process.env.WINCH_DISPATCH_MAX_CONCURRENT ?? 8),
        statePath: process.env.WINCH_DISPATCH_STATE_PATH ?? defaultStatePath(),
        logger: console,
      });
    };
    const orig = hooks["chat.message"];
    hooks["chat.message"] = async (input) => {
      if (typeof orig === "function") await orig(input);
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
