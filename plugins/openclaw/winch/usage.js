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

// llm_output is the only hook carrying token counts on agent-command runs
// (the wake path): reply_payload_sending arrives with usageState undefined
// there because the host consumes the recorded snapshot only for inbound
// replies. Attempts accumulate per runId; agent_end and reply flush pass
// turnRef=runId so the server's unique index dedupes a double report.
export function llmOutputUsage(event, ctx) {
  const raw = event?.usage;
  if (!raw || typeof raw !== "object") return null;
  const usage = {
    model: typeof event.resolvedRef === "string" && event.resolvedRef
      ? event.resolvedRef
      : (event.provider && event.model ? `${event.provider}/${event.model}` : null),
    tokensIn: num(raw.input),
    tokensOut: num(raw.output),
    cacheRead: num(raw.cacheRead),
  };
  if (usage.tokensIn === null && usage.tokensOut === null && usage.cacheRead === null) return null;
  const runId = typeof event.runId === "string" && event.runId ? event.runId : null;
  const session = typeof ctx?.sessionKey === "string" && ctx.sessionKey ? ctx.sessionKey : null;
  const agent = typeof ctx?.agentId === "string" && ctx.agentId ? ctx.agentId : null;
  if (!runId || !session || !agent) return null;
  return { runId, agent, session, usage };
}

function sumNullable(a, b) {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

// FIFO-bounded: llm_output fires for every run in the gateway, engaged or
// not; engagement is checked at flush, not at accumulation, because a session
// binds to its item mid-run (first tool call) after earlier attempts.
export function accumulateUsage(runs, snap, max = 500) {
  const prev = runs.get(snap.runId);
  if (prev) {
    prev.usage.tokensIn = sumNullable(prev.usage.tokensIn, snap.usage.tokensIn);
    prev.usage.tokensOut = sumNullable(prev.usage.tokensOut, snap.usage.tokensOut);
    prev.usage.cacheRead = sumNullable(prev.usage.cacheRead, snap.usage.cacheRead);
    if (snap.usage.model) prev.usage.model = snap.usage.model;
    return;
  }
  if (runs.size >= max) runs.delete(runs.keys().next().value);
  runs.set(snap.runId, { agent: snap.agent, session: snap.session, usage: { ...snap.usage } });
}

export function runUsageBody({ event, runs, harness }) {
  const runId = typeof event?.runId === "string" && event.runId ? event.runId : null;
  const snap = runId && runs ? runs.get(runId) : null;
  if (!snap) return null;
  return usageBody({ harness, agent: snap.agent, session: snap.session, turnRef: runId, usage: snap.usage });
}

function usageStateBody({ event, harness }) {
  const reported = usageFromReplyEvent(event);
  if (!reported) return null;
  return usageBody({ harness, ...reported });
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

// Fire-and-forget entry used by the hooks; returns the body when it posted.
// The per-run accumulator wins over usageState: on agent-command runs the
// host never attaches usageState, and the accumulator holds the summed
// attempts either way.
export function reportReplyUsage({ event, runs, harness, baseUrl, token, logger = console, fetchImpl = fetch }) {
  const body = runUsageBody({ event, runs, harness }) ?? usageStateBody({ event, harness });
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
