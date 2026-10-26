// autoregister.js — self-wiring: on gateway boot the plugin registers its
// own claim route in winch, so no operator runs `winch webhook set` by hand.
//
// Preconditions (else it logs the exact manual command and skips):
//   - webhookBearer (or legacy top-level) configured — the shared secret;
//   - a reachable winch binary (pluginConfig webhookWinchBin, WINCH_BIN env,
//     else `winch` on PATH) backed by the SAME store the harness claims from
//     (true for the standard same-machine stdio layout);
//   - the gateway's public base URL (pluginConfig webhookPublicBaseUrl, else
//     http://127.0.0.1:<gateway port>/api/winch/claimed).
// Registration is idempotent (upsert) and verified with `winch webhook test`.
// Never throws: boot must not fail because a webhook couldn't register.

import { execFile as execFileCb } from "node:child_process";

// The `winch` used here is the same one the harness's MCP entry spawns, so
// both talk to the same store: explicit config → WINCH_BIN → PATH. The
// package dependency only pins the server version that ships alongside.
export function autoregisterConfig(pluginConfig = {}, apiConfig = {}) {
  const bearer = pluginConfig.webhookBearer ?? pluginConfig.webhook?.bearer ?? "";
  const baseUrl =
    pluginConfig.webhookPublicBaseUrl ??
    pluginConfig.webhook?.publicBaseUrl ??
    (apiConfig?.gateway?.port ? `http://127.0.0.1:${apiConfig.gateway.port}` : null);
  const harness = pluginConfig.webhookHarness ?? pluginConfig.webhook?.harness ?? "openclaw";
  const winchBin =
    pluginConfig.webhookWinchBin ??
    pluginConfig.webhook?.winchBin ??
    process.env.WINCH_BIN ??
    "winch";
  const enabled = pluginConfig.webhookAutoregister ?? pluginConfig.webhook?.autoregister ?? true;
  return { bearer, baseUrl, harness, winchBin, enabled };
}

export function manualCommand({ baseUrl, harness, bearer }) {
  const url = `${baseUrl?.replace(/\/$/, "") ?? "<gateway-url>"}/api/winch/claimed`;
  return `winch webhook set --harness ${harness} --url ${url} --bearer ${bearer ? "<secret>" : "<same-as-webhookBearer>"}`;
}

// A .js target is the bundled bin (no PATH shim needed): run it with the
// current Node. A bare name stays a PATH lookup.
function invocation(winchBin, args) {
  return winchBin.endsWith(".js")
    ? { bin: process.execPath, argv: [winchBin, ...args] }
    : { bin: winchBin, argv: args };
}

function runBin(winchBin, args, runner) {
  const { bin, argv } = invocation(winchBin, args);
  return new Promise((resolve) => {
    const run = runner ?? ((b, a, cb) => execFileCb(b, a, { timeout: 15000 }, cb));
    run(bin, argv, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: (stderr || err.message || String(err)).trim().slice(0, 300) });
      else resolve({ ok: true, output: String(stdout || "").trim().slice(0, 500) });
    });
  });
}

/**
 * Register + verify. Returns {ok:true} | {ok:false, reason, manual}.
 * `runner` is injectable: (bin, args, cb) => void.
 */
export async function autoregister({ api, logger, runner } = {}) {
  const log = logger ?? api?.logger;
  const cfg = autoregisterConfig(api?.pluginConfig, api?.config);
  if (!cfg.enabled) return { ok: false, reason: "disabled" };
  if (!cfg.bearer) {
    return { ok: false, reason: "disarmed", manual: "set webhookBearer in the winch plugin config first" };
  }
  if (!cfg.baseUrl) {
    return { ok: false, reason: "no-base-url", manual: manualCommand({ ...cfg, baseUrl: null }) };
  }
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/api/winch/claimed`;
  const setArgs = ["webhook", "set", "--harness", cfg.harness, "--url", url, "--bearer", cfg.bearer];
  const set = await runBin(cfg.winchBin, setArgs, runner);
  if (!set.ok) {
    log?.warn?.(`winch: claim webhook self-registration failed: ${set.error}`);
    return { ok: false, reason: "set-failed", manual: manualCommand({ ...cfg, baseUrl: cfg.baseUrl }) };
  }
  const tested = await runBin(cfg.winchBin, ["webhook", "test", "--harness", cfg.harness], runner);
  if (!tested.ok) {
    log?.warn?.(`winch: claim webhook registered but test ping failed: ${tested.error}`);
    return { ok: false, reason: "test-failed", manual: manualCommand({ ...cfg, baseUrl: cfg.baseUrl }) };
  }
  log?.info?.(`winch: claim webhook self-registered for harness ${cfg.harness} -> ${url}`);
  return { ok: true };
}
