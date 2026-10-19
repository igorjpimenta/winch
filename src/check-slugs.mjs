#!/usr/bin/env node
// check-slugs.mjs — re-validate registered model slugs against the live
// provider endpoints (the S0.5 ground truth, made re-runnable).
//
// Usage: winch check-slugs [--config <path>]
//       — exits 0 when config and endpoints agree.
// Keys come from ~/.openclaw/service-env/ai.openclaw.gateway.env (read, never
// printed) or the ambient environment.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Config path: --config flag, else WINCH_MODELS_CONFIG, else the default
// openclaw.json under the user's home. A missing config is a hard error —
// validating against nothing is worse than not running.
const argv = process.argv.slice(2);
const cfgFlag = argv.indexOf("--config");
const cfgPath = cfgFlag >= 0
  ? argv[cfgFlag + 1]
  : (process.env.WINCH_MODELS_CONFIG || path.join(os.homedir(), ".openclaw", "openclaw.json"));
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

function loadKeys() {
  const keys = { ...process.env };
  const envFile = path.join(os.homedir(), ".openclaw", "service-env", "ai.openclaw.gateway.env");
  try {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
      if (m) keys[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* ambient env only */ }
  return keys;
}

async function listModels(baseUrl, key) {
  const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return new Set((body.data ?? []).map((m) => m.id));
}

// /models can omit ids the endpoint still serves (legacy catalog drift), so an
// unlisted id is a warning until a 1-token completion proves it dead — only a
// failed probe is a real mismatch.
async function probeServes(t, key, model) {
  const bodies = { "anthropic-messages": {"model": model, "max_tokens": 1, "messages": [{"role": "user", "content": "hi"}]},
                   "openai-completions": {"model": model, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 1} };
  const api = t.api ?? "openai-completions";
  const paths = api === "anthropic-messages" ? ["v1/messages", "messages"] : ["chat/completions"];
  const headers = api === "anthropic-messages"
    ? { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }
    : { Authorization: `Bearer ${key}`, "content-type": "application/json" };
  // baseUrl may carry an openai-style /v1 (used by /models); the anthropic
  // messages route hangs off the provider root instead.
  const root = api === "anthropic-messages" ? t.baseUrl.replace(/\/v1\/?$/, "/") : t.baseUrl;
  for (const p of paths) {
    try {
      const res = await fetch(`${root}${p}`, { method: "POST", headers, body: JSON.stringify(bodies[api]) });
      if (res.ok) return true;
    } catch { /* try next path */ }
  }
  return false;
}

const targets = [
  { provider: "zai-coding", baseUrl: "https://api.z.ai/api/coding/paas/v4", keyName: "ZAI_API_KEY", api: "openai-completions" },
  { provider: "kimi", baseUrl: "https://api.kimi.com/coding/v1", keyName: "KIMI_API_KEY", api: "anthropic-messages" },
];

const keys = loadKeys();
let failures = 0;
let warnings = 0;

for (const t of targets) {
  const provider = cfg.models.providers[t.provider];
  if (!provider) { console.error(`missing provider ${t.provider}`); failures++; continue; }
  const key = keys[t.keyName];
  if (!key) { console.error(`no key for ${t.keyName} — cannot verify ${t.provider}`); failures++; continue; }
  let live;
  try {
    live = await listModels(t.baseUrl, key);
  } catch (e) {
    console.error(`${t.provider}: endpoint unreachable (${e.message})`);
    failures++;
    continue;
  }
  for (const m of provider.models) {
    if (live.has(m.id)) { console.log(`OK   ${t.provider}/${m.id}`); continue; }
    const serves = await probeServes(t, key, m.id);
    if (serves) { warnings++; console.log(`WARN ${t.provider}/${m.id} — unlisted in /models but still serves (catalog drift)`); }
    else { failures++; console.log(`DEAD ${t.provider}/${m.id} — not listed and probe failed`); }
  }
}

console.log(failures === 0
  ? `all registered slugs live-verified (${warnings} catalog-drift warning(s))`
  : `${failures} dead slug(s), ${warnings} warning(s)`);
process.exit(failures === 0 ? 0 : 1);
