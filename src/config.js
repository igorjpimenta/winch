// config.js — layered tuning config, declared the way the harness is.
//
// Precedence: per-call `_meta.winch.config` > constructor `{ config }` >
// `WINCH_*` env > code defaults. Nothing here is required: every knob has a
// safe default, so a server started with no config behaves exactly like the
// old hardcoded one. (Identity is the opposite — the triple refuses when
// absent. Config never refuses for being absent; it refuses only for being
// malformed, naming the key, the way a bad harness declaration does.)

const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;
const UNIT_MS = { ms: 1, s: 1000, m: 60 * 1000, h: 3600 * 1000, d: 24 * 3600 * 1000 };

function parseLevelToken(tok) {
  const m = String(tok ?? "").trim().match(DURATION_RE);
  if (!m) return null;
  return { ms: Number(m[1]) * UNIT_MS[m[2]], label: String(tok).trim() };
}

function parseGateWaitLevels(raw) {
  const toks = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
  const levels = [];
  for (const t of toks) {
    if (t != null && typeof t === "object" && Number.isFinite(t.ms)) {
      levels.push({ ms: Math.floor(t.ms), label: String(t.label ?? `${t.ms}ms`) });
      continue;
    }
    const p = parseLevelToken(t);
    if (!p || p.ms <= 0) return null;
    levels.push(p);
  }
  if (!levels.length) return null;
  return [...levels].sort((a, b) => a.ms - b.ms);
}

function parseInt(raw) {
  if (typeof raw === "number") return Number.isInteger(raw) ? raw : null;
  const s = String(raw ?? "").trim();
  if (!/^\d+$/.test(s)) return null;
  return Number(s);
}

// key -> { env, parse, check }. parse normalizes (string|number|array) to the
// stored shape; check rejects out-of-range values. Stored shapes are plain
// JSON: a resolved config survives a round-trip through JSON by construction.
const SPEC = {
  leaseSeconds:       { env: "WINCH_LEASE_SECONDS",       parse: parseInt, check: (v) => v > 0 },
  maxAttempts:        { env: "WINCH_MAX_ATTEMPTS",        parse: parseInt, check: (v) => v > 0 },
  gateWaitLevels:     { env: "WINCH_GATE_WAIT_LEVELS",    parse: parseGateWaitLevels, check: (v) => v !== null },
  wsPort:             { env: "WINCH_WS_PORT",             parse: parseInt, check: (v) => v >= 1 && v <= 65535 },
  mcpHttpPort:        { env: "WINCH_MCP_HTTP_PORT",       parse: parseInt, check: (v) => v >= 1 && v <= 65535 },
  wsHistoryLimit:     { env: "WINCH_WS_HISTORY_LIMIT",    parse: parseInt, check: (v) => v > 0 },
  wsIntervalMs:       { env: "WINCH_WS_INTERVAL_MS",      parse: parseInt, check: (v) => v > 0 },
  maxActivePerAgent:  { env: "WINCH_MAX_ACTIVE_PER_AGENT", parse: parseInt, check: (v) => v > 0 },
  scanLimit:          { env: "WINCH_SCAN_LIMIT",          parse: parseInt, check: (v) => v > 0 },
  candidates:         { env: "WINCH_CANDIDATES",          parse: parseInt, check: (v) => v > 0 },
  blockedLimit:       { env: "WINCH_BLOCKED_LIMIT",       parse: parseInt, check: (v) => v > 0 },
  dfsNodes:           { env: "WINCH_DFS_NODES",           parse: parseInt, check: (v) => v > 0 },
  noteProgressLimit:  { env: "WINCH_NOTE_PROGRESS_LIMIT", parse: parseInt, check: (v) => v > 0 },
  noteResultLimit:    { env: "WINCH_NOTE_RESULT_LIMIT",   parse: parseInt, check: (v) => v > 0 },
  noteReasonLimit:    { env: "WINCH_NOTE_REASON_LIMIT",   parse: parseInt, check: (v) => v > 0 },
  noteArtifactLimit:  { env: "WINCH_NOTE_ARTIFACT_LIMIT", parse: parseInt, check: (v) => v > 0 },
  maxArtifacts:       { env: "WINCH_MAX_ARTIFACTS",       parse: parseInt, check: (v) => v > 0 },
};

export const CONFIG_DEFAULTS = {
  leaseSeconds: 1800,
  maxAttempts: 3,
  gateWaitLevels: "24h,72h",
  wsPort: 38291,
  mcpHttpPort: 38292,
  wsHistoryLimit: 200,
  wsIntervalMs: 1000,
  maxActivePerAgent: 2,
  scanLimit: 50,
  candidates: 5,
  blockedLimit: 20,
  dfsNodes: 500,
  noteProgressLimit: 2000,
  noteResultLimit: 4000,
  noteReasonLimit: 1000,
  noteArtifactLimit: 500,
  maxArtifacts: 50,
};

export const CONFIG_ENV = Object.fromEntries(
  Object.entries(SPEC).map(([key, s]) => [key, s.env])
);

function refused(what, key, hint) {
  throw new Error(`winch: refused ${what} (bad ${key}). ${hint}`);
}

function parseKey(key, raw, what) {
  const spec = SPEC[key];
  const parsed = spec.parse(raw);
  if (parsed === null || !spec.check(parsed)) {
    refused(what, key, `Expected ${key === "gateWaitLevels" ? "a duration list like \"24h,72h\"" : key === "wsPort" ? "a port 1-65535" : "a positive integer"} — got ${JSON.stringify(raw) ?? "nothing"}.`);
  }
  return parsed;
}

/**
 * Construction-time config: explicit object wins, then WINCH_* env, then
 * code defaults. Unknown explicit keys refuse — a typo'd knob must fail at
 * startup, not run for a month at the default while the operator believes
 * otherwise. Env carries only known vars, so there is nothing to reject there.
 */
export function resolveConfig({ explicit = {}, env = process.env } = {}) {
  if (explicit == null || typeof explicit !== "object" || Array.isArray(explicit)) {
    refused("config", "config", "Pass an object keyed by knob name.");
  }
  for (const key of Object.keys(explicit)) {
    if (!SPEC[key]) refused("config", key, `Unknown knob — known: ${Object.keys(SPEC).join(", ")}.`);
  }
  const out = {};
  for (const [key, spec] of Object.entries(SPEC)) {
    if (explicit[key] !== undefined) {
      out[key] = parseKey(key, explicit[key], "config");
      continue;
    }
    const envRaw = env?.[spec.env];
    if (envRaw !== undefined && envRaw !== "") {
      out[key] = parseKey(key, envRaw, `config (env ${spec.env})`);
      continue;
    }
    out[key] = parseKey(key, CONFIG_DEFAULTS[key], "config");
  }
  return out;
}

/**
 * Per-call overlay: `_meta.winch.config` merges over the construction
 * config. Unknown keys are ignored (a newer harness stamping knobs an older
 * server never heard of must not break the call); malformed known keys
 * refuse the call, the way an unstamped identity does.
 */
export function resolveRequestConfig(base, meta) {
  const patch = meta?.winch?.config ?? null;
  if (patch == null) return base;
  if (typeof patch !== "object" || Array.isArray(patch)) {
    refused("caller config", "config", "Pass an object keyed by knob name.");
  }
  const out = { ...base };
  for (const [key, raw] of Object.entries(patch)) {
    if (!SPEC[key] || raw === undefined) continue;
    out[key] = parseKey(key, raw, "caller config");
  }
  return out;
}
