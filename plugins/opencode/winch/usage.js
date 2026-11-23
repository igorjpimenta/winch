// usage.js — report per-turn LLM usage to winch's dispatch server.
//
// OpenCode emits `message.updated` on its event bus; an assistant message with
// `finish` (or a completed timestamp) is final and carries the accumulated
// `cost` and the last step's token snapshot. Posting is fire-and-forget and
// idempotent per message id (the server dedups on turnRef).

import { DEFAULT_DISPATCH_URL } from "./dispatch.js";

const USAGE_PATH = "/usage";
const DEFAULT_TIMEOUT_MS = 2000;

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasNumbers(usage) {
  return usage.tokensIn !== null || usage.tokensOut !== null || usage.cacheRead !== null || usage.costUsd !== null;
}

// A turn's usage is final only once the assistant message has finished; the
// same message id appears earlier in `message.updated` without usage totals.
export function isFinalAssistant(info) {
  return !!info && info.role === "assistant" && (info.finish != null || info.time?.completed != null);
}

// AssistantMessage -> { agent, session, usage, turnRef } | null
export function usageFromAssistantMessage(info) {
  if (!isFinalAssistant(info)) return null;
  const tokens = info.tokens ?? {};
  const cache = tokens.cache ?? {};
  const usage = {
    model: info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : info.modelID ?? null,
    tokensIn: num(tokens.input),
    tokensOut: num(tokens.output),
    cacheRead: num(cache.read),
    costUsd: num(info.cost),
  };
  if (!hasNumbers(usage)) return null;
  return {
    agent: info.agent ?? null,
    session: info.sessionID ?? null,
    usage,
    turnRef: info.id ?? null,
  };
}

// The winch server keys sessions by `<harness>:<agent>:<external session>`.
export function usageBody({ harness, agent, session, usage, turnRef }) {
  if (!agent || !session || !usage) return null;
  return { sessionKey: `${harness}:${agent}:${session}`, turnRef: turnRef ?? null, usage };
}

export async function postUsage({
  baseUrl = DEFAULT_DISPATCH_URL,
  token,
  body,
  logger = console,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!body) return false;
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}${USAGE_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger?.warn?.(`winch: usage report ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    logger?.warn?.(`winch: usage report failed: ${err?.message ?? err}`);
    return false;
  }
}

// Fire-and-forget entry used by the event hook; returns the body when posted.
export function reportAssistantUsage({
  info,
  harness,
  agent = null,
  baseUrl = process.env.WINCH_DISPATCH_URL ?? DEFAULT_DISPATCH_URL,
  token = process.env.WINCH_DISPATCH_TOKEN,
  logger = console,
  fetchImpl = fetch,
}) {
  const reported = usageFromAssistantMessage(info);
  if (!reported) return null;
  const body = usageBody({ harness, agent: agent ?? reported.agent, session: reported.session, usage: reported.usage, turnRef: reported.turnRef });
  if (!body) return null;
  void postUsage({ baseUrl, token, body, logger, fetchImpl });
  return body;
}

// Keeps a bounded set: message ids so repeated message.updated frames do not
// re-post, and session ids so only winch-bound sessions report usage.
export function remember(seen, key, max = 1000) {
  if (!key) return true;
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > max) seen.delete(seen.values().next().value);
  return true;
}
