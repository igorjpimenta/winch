// host.js — minimum-host floor for the session-context contract. Pure
// functions, no plugin-SDK import, so they load under `node --test plugins/`
// like meta.js.
//
// buildWinchMeta reads agentId/sessionKey/sessionId/runId from the hook
// context, which the host only threads into bundled MCP tool calls since
// v2026.5.16-beta.7 (oldest compatible stable: v2026.5.18 — verified against
// the tag: attempt.ts builds catalogToolHookContext, tool-split forwards it,
// the adapter passes ctx to runBeforeToolCallHook). The manifest schema has
// no engines/min-version field, so the floor lives here and is enforced in
// register(): below floor → error log, hook NOT registered (fail loudly,
// matching project convention — a registered-but-blind hook would only
// produce confusing server refusals); version undeterminable → warn once and
// register anyway (fail-open on detection; the server still fail-closes on
// identity, so nothing can poison).

export const MIN_HOST_VERSION = "2026.5.18";

export function parseVersion(v) {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^v/i, "");
  if (s === "") return null;
  const dash = s.indexOf("-");
  const corePart = dash < 0 ? s : s.slice(0, dash);
  const pre = dash < 0 ? null : s.slice(dash + 1) || null;
  const core = corePart.split(".");
  if (core.length === 0 || core.some((p) => !/^\d+$/.test(p))) return null;
  return { core: core.map(Number), pre };
}

// -1 | 0 | 1. null when either side is unparseable (caller treats as unknown).
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  const n = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < n; i++) {
    const x = pa.core[i] ?? 0;
    const y = pb.core[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export function readHostVersion(api, env = process.env) {
  const candidates = [
    api?.version,
    api?.hostVersion,
    api?.gatewayVersion,
    env?.OPENCLAW_VERSION,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c.trim();
  }
  return null;
}

// { ok: true, version } — register.
// { ok: true, version: null|string, warned: true } — register + warn once.
// { ok: false, version, reason } — do NOT register.
export function checkHostFloor(api, env) {
  const version = readHostVersion(api, env);
  if (version === null) {
    return { ok: true, version: null, warned: true };
  }
  const cmp = compareVersions(version, MIN_HOST_VERSION);
  if (cmp === null) {
    return { ok: true, version, warned: true };
  }
  if (cmp < 0) {
    return {
      ok: false,
      version,
      reason:
        `host ${version} predates hook session context ` +
        `(floor ${MIN_HOST_VERSION}); refusing to register`,
    };
  }
  return { ok: true, version };
}
