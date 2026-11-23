// usage.js — report per-turn LLM usage to winch's dispatch server.
//
// The gateway attaches one usage snapshot per run to the first outbound payload
// (reply_payload_sending.usageState); later payloads of the same run do not
// carry it, so a report per snapshot is already one per turn. Posting is
// fire-and-forget: reporting must never delay or fail reply delivery.

const USAGE_PATH = "/usage";
const DEFAULT_TIMEOUT_MS = 2000;

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasNumbers(usage) {
  return usage.tokensIn !== null || usage.tokensOut !== null || usage.cacheRead !== null || usage.costUsd !== null;
}

// reply_payload_sending -> { agent, session, usage, turnRef } | null
export function usageFromReplyEvent(event) {
  const state = event?.usageState;
  if (!state) return null;
  const model = state.resolvedRef ?? state.model ?? null;
  const costUsd = num(state.turnUsd);
  const identity = {
    agent: state.agentId ?? null,
    session: event?.sessionKey ?? state.sessionId ?? event?.runId ?? null,
    turnRef: event?.runId ?? null,
  };
  // The aggregate covers the whole tool loop; lastUsage is the final call only.
  for (const observed of [state.usage, state.lastUsage]) {
    if (!observed) continue;
    const usage = {
      model,
      tokensIn: num(observed.input),
      tokensOut: num(observed.output),
      cacheRead: num(observed.cacheRead),
      costUsd,
    };
    if (hasNumbers(usage)) return { ...identity, usage };
  }
  if (costUsd !== null) {
    return { ...identity, usage: { model, tokensIn: null, tokensOut: null, cacheRead: null, costUsd } };
  }
  return null;
}

const ITEM_ID_KEYS = ["taskId", "task_id", "id", "epicId", "epic_id", "storyId", "story_id"];

// The server binds a session to an item only for a call carrying an item id
// (backlog_claim, get, update, append, ...). accept_wake carries an
// admissionId, so it alone does not bind; reporting is armed on the first call
// that can actually attribute the row.
export function carriesItemId(args) {
  if (!args || typeof args !== "object") return false;
  return ITEM_ID_KEYS.some((key) => typeof args[key] === "string" && args[key].trim() !== "");
}

// The winch server keys sessions by `<harness>:<agent>:<external session>`.
export function usageBody({ harness, agent, session, usage, turnRef }) {
  if (!agent || !session || !usage) return null;
  return { sessionKey: `${harness}:${agent}:${session}`, turnRef: turnRef ?? null, usage };
}

export async function postUsage({
  baseUrl,
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

// Fire-and-forget entry used by the hook; returns the body when it posted.
export function reportReplyUsage({ event, harness, baseUrl, token, logger = console, fetchImpl = fetch }) {
  const reported = usageFromReplyEvent(event);
  if (!reported) return null;
  const body = usageBody({ harness, ...reported });
  if (!body) return null;
  void postUsage({ baseUrl, token, body, logger, fetchImpl });
  return body;
}

// Bounded membership set: keeps engagement and turn keys from growing forever.
export function remember(seen, key, max = 1000) {
  if (!key) return true;
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > max) seen.delete(seen.values().next().value);
  return true;
}
