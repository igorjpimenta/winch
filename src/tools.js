// tools.js — agent-facing backlog tools: backlog_next / _update / _done /
// _block / _resume.
//
// `createToolHandlers(store, logger)` returns static TOOL_DEFS (name,
// description, JSON-schema inputSchema) plus a `handle(name, args, identity)`
// dispatcher. The caller identity is the resolved `identity` — never a tool
// param — so agents cannot claim work under another agent's name. Claim
// semantics are the store's CAS (`status='todo' AND (assigned IS NULL OR
// assigned=?)`): a loser of a race gets `claim === null` and simply tries the
// next candidate — there is no blocking wait inside a tool call.

import { readyTasks } from "./ready-queue.js";
import { addDep } from "./deps.js";
import { identitySessionKey, assertCleanTriple } from "./identity.js";

// Session budgets count backlog tool calls per sessionKey, not model turns.
// The agent rollup sums every session a single agent ever charged, so a fresh
// wake cannot respawn a full allowance — the latch that stops a runaway
// session, plus the rollup that stops a runaway campaign. Latching is one-way:
// exhausted sessions halt new claims mid-session by design. If the runner ever
// grows an agent-loop turn cap, wire budgets there and retire this counter.
export const SESSION_TOOL_BUDGETS = { atlas: 120, scout: 40, forge: 60, builder: 120, lens: 60, herald: 40 };
const DEFAULT_SESSION_BUDGET = 60;
// Campaign allowance per agent, defaulting to a multiple of the session
// budget: a campaign that needs more than ~5 sessions of calls is itself the
// runaway the session latch cannot see. Per-agent overrides win.
export const AGENT_TOOL_BUDGETS = {};
const DEFAULT_AGENT_BUDGET_MULTIPLE = 5;

function ok(text, details) {
  return { content: [{ type: "text", text }], details };
}

function err(text, reason, extra = {}) {
  return { content: [{ type: "text", text }], details: { status: "rejected", reason, ...extra } };
}

function clampNote(s, max = 2000) {
  if (typeof s !== "string") return null;
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// Artifacts upstream tasks recorded on this story: addArtifact events plus
// done-result artifact lists, deduped. Everything read is a store row.
export function collectStoryArtifacts(store, storyId) {
  const out = new Set();
  for (const t of store.task.list({ storyId })) {
    const evs = store.db.prepare("SELECT note FROM events WHERE task_id=? AND note LIKE 'artifact:%'").all(t.id);
    for (const e of evs) out.add(e.note.slice("artifact: ".length).trim());
    const m = t.result_summary ? t.result_summary.match(/\nartifacts: (.+)$/) : null;
    if (m) for (const a of m[1].split(",")) out.add(a.trim());
  }
  return [...out];
}

// Rendered exclusively from store rows (task/story/epic/artifact events).
// No session history, call params, or conversation content can enter this
// string — that is the handoff contract: a receiver prompt is a projection
// of the store, nothing else.
function renderReceiverPrompt({ task, story, epic, artifacts }) {
  const parts = [
    `# Task: ${task.title}`,
    task.description ? `## Context\n${task.description}` : null,
    `## Acceptance\n${story.acceptance ?? "(none recorded)"}`,
    `## Upstream artifacts\n${artifacts.length ? artifacts.map((a) => `- ${a}`).join("\n") : "(none yet)"}`,
    `## Parent\n${epic.title} — ${story.title}`,
  ];
  return parts.filter(Boolean).join("\n\n");
}

export function createToolHandlers(store, logger) {
  function chargeBudget(identity) {
    const limit = SESSION_TOOL_BUDGETS[identity.agent] ?? DEFAULT_SESSION_BUDGET;
    const agentLimit = AGENT_TOOL_BUDGETS[identity.agent] ?? limit * DEFAULT_AGENT_BUDGET_MULTIPLE;
    return store.sessionBudget.charge({ sessionKey: identitySessionKey(identity), agentId: identity.agent, limit, agentLimit });
  }

  const TOOL_DEFS = [
    {
      name: "backlog_next",
      description:
        "Atomically claim the highest-priority ready task for THIS agent (identity resolved from request meta / environment). " +
        "Returns the task with its story/epic acceptance criteria and execution args, or `{empty}` when nothing " +
        "is claimable. A race loser silently gets the next candidate. Call on every wake; if empty, do not invent work.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          capabilities: {
            type: "array",
            items: { type: "string" },
            description: "Capability tags this agent offers; filters tasks whose required caps intersect.",
          },
          dryRun: {
            type: "boolean",
            description: "Report the next claimable task without claiming it.",
          },
        },
      },
    },
    {
      name: "backlog_update",
      description:
        "Report liveness and progress on a task you have claimed. `heartbeat: true` refreshes last_heartbeat " +
        "(the sweeper reclaims tasks whose lease expires without heartbeats). `progressSummary`/`comment` append " +
        "an audit event. Only the assigned agent may update.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["taskId"],
        properties: {
          taskId: { type: "string", description: "Task id (TASK-…)." },
          heartbeat: { type: "boolean", description: "Refresh liveness (default true)." },
          progressSummary: { type: "string", description: "One-line progress note for the audit trail." },
          comment: { type: "string", description: "Freeform note appended as an audit event." },
          addArtifact: { type: "string", description: "Artifact path/URL produced so far; recorded as an audit event and carried into downstream handoffs." },
        },
      },
    },
    {
      name: "backlog_done",
      description:
        "Close a task you have claimed: status → done, result summary recorded, audit event appended. " +
        "Only the assigned agent may complete it. The next dependent task becomes claimable.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["taskId", "resultSummary"],
        properties: {
          taskId: { type: "string", description: "Task id (TASK-…)." },
          resultSummary: { type: "string", description: "One-paragraph outcome (success or failure)." },
          artifacts: { type: "array", items: { type: "string" }, description: "Paths/URLs of produced artifacts (diff, doc, PR)." },
        },
      },
    },
    {
      name: "backlog_block",
      description:
        "Mark a task you have claimed as blocked with a reason; optionally declare what it is blocked by " +
        "(`blockedBy: {kind, id}`) which adds a dependency edge (cycle-checked). Blocked tasks leave the " +
        "ready queue until an operator unblocks them. Only the assigned agent may block.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["taskId", "reason"],
        properties: {
          taskId: { type: "string", description: "Task id (TASK-…)." },
          reason: { type: "string", description: "Why the task cannot proceed." },
          gateType: { type: "string", description: "Human gate being opened (roadmap|architecture|release|custom) — stamps gate_type; resume clears it." },
          blockedBy: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "id"],
            properties: {
              kind: { type: "string", enum: ["epic", "story", "task"] },
              id: { type: "string" },
            },
            description: "Item this task now depends on (edge added, cycle-checked).",
          },
        },
      },
    },
    {
      name: "backlog_resume",
      description:
        "Operator resolution of a human gate: blocked → todo with claim fields and gate metadata cleared, " +
        "so the task re-enters the queue for a fresh claim. One resume per gate — a second call is rejected " +
        "as not_resumable.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["taskId"],
        properties: {
          taskId: { type: "string", description: "Task id (TASK-…)." },
          actor: { type: "string", description: "Identity recorded on the resume event; defaults to the caller's agent." },
        },
      },
    },
  ];

  const handlers = {
    async backlog_next(args, identity) {
      const agentId = identity.agent;
      const sessionKey = identitySessionKey(identity);
      const budget = chargeBudget(identity);
      if (budget.exhausted || budget.agentExhausted) {
        // Latch marker goes on the wire even with no current task: NULL
        // task_id + NULL statuses is the taskless shape, matched by note
        // vocabulary ahead of every status rule.
        // Session exhaustion keeps its exact note and guidance (existing
        // tests and the metrics bucket match on the prefix); agent-only
        // exhaustion gets its own vocabulary. When both trip, the session
        // note wins — the agent is ending this session either way.
        const sessionScope = budget.exhausted;
        const note = sessionScope
          ? `session budget exhausted: ${budget.tool_calls}/${budget.limit_calls} backlog calls; claims halted`
          : `agent budget exhausted: ${budget.agentToolCalls}/${budget.agentLimitCalls} backlog calls across sessions; claims halted`;
        const cur = store.db.prepare(
          "SELECT id FROM tasks WHERE assigned=? AND status='in_progress' ORDER BY claimed_at DESC LIMIT 1"
        ).get(agentId);
        store.db.prepare(
          "INSERT INTO events(task_id, from_status, to_status, actor, note, at) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(cur?.id ?? null, cur ? "in_progress" : null, cur ? "in_progress" : null, agentId, note, Date.now());
        const guidance = sessionScope
          ? "Session budget exhausted — finish the current task with backlog_done, then end the session with a final summary. Do not retry claiming."
          : "Agent budget exhausted across sessions — finish the current task with backlog_done, then end the session. Further wakes will also halt: this needs an operator, not a retry.";
        return ok(
          JSON.stringify({ exhausted: true, scope: sessionScope ? "session" : "agent", toolCalls: budget.tool_calls, limit: budget.limit_calls, agentToolCalls: budget.agentToolCalls, agentLimit: budget.agentLimitCalls, guidance }),
          { status: "budget_exhausted", scope: sessionScope ? "session" : "agent", agentId, toolCalls: budget.tool_calls, limit: budget.limit_calls }
        );
      }
      try {
        const candidates = readyTasks(store, { agentId, capabilities: args?.capabilities, limit: 5 });
        if (candidates.length === 0) {
          store.sessionBudget.recordEmptyWake(budget.session_key);
          return ok(JSON.stringify({ empty: true }), { status: "empty", agentId });
        }
        if (args?.dryRun) {
          const c = candidates[0];
          return ok(JSON.stringify({ dryRun: true, task: c.task, story: { id: c.story.id, title: c.story.title, acceptance: c.story.acceptance }, epic: { id: c.epic.id, title: c.epic.title } }), { status: "ok", dryRun: true, agentId });
        }
        for (const c of candidates) {
          const claimed = store.task.claim({ id: c.task.id, agentId, sessionKey });
          if (!claimed) continue; // raced — next candidate
          logger?.info?.(`backlog: ${agentId} claimed ${claimed.id}`);
          const artifacts = collectStoryArtifacts(store, c.story.id);
          return ok(
            JSON.stringify({
              task: claimed,
              story: { id: c.story.id, title: c.story.title, acceptance: c.story.acceptance, priority: c.story.priority },
              epic: { id: c.epic.id, title: c.epic.title, priority: c.epic.priority },
              handoff: {
                reason: "ready-queue claim",
                priority: c.story.priority,
                acceptance_criteria: c.story.acceptance,
                artifacts,
                receiverPrompt: renderReceiverPrompt({ task: claimed, story: c.story, epic: c.epic, artifacts }),
              },
            }),
            { status: "ok", agentId, taskId: claimed.id }
          );
        }
        store.sessionBudget.recordEmptyWake(budget.session_key);
        return ok(JSON.stringify({ empty: true, raced: true }), { status: "empty", reason: "all_candidates_raced", agentId });
      } catch (e) {
        logger?.warn?.(`backlog_next failed: ${e?.message}`);
        return err(`backlog_next failed: ${e?.message}`, "error");
      }
    },

    async backlog_update(args, identity) {
      const agentId = identity.agent;
      const budget = chargeBudget(identity);
      const task = store.task.get(args?.taskId);
      if (!task) return err(`backlog_update: not found: ${args?.taskId}`, "not_found");
      if (task.status !== "in_progress") return err(`${task.id} is ${task.status}, not in_progress — claim it with backlog_next first.`, "not_claimed", { taskId: task.id });
      if (task.assigned !== agentId) return err(`${task.id} is assigned to ${task.assigned}, not ${agentId}.`, "not_assignee", { taskId: task.id, assigned: task.assigned });
      try {
        const wantHeartbeat = args?.heartbeat !== false;
        if (wantHeartbeat) store.task.heartbeat(task.id, agentId);
        const noteParts = [];
        if (args?.progressSummary) noteParts.push(`progress: ${clampNote(args.progressSummary)}`);
        if (args?.comment) noteParts.push(`comment: ${clampNote(args.comment)}`);
        if (args?.addArtifact) noteParts.push(`artifact: ${clampNote(args.addArtifact, 500)}`);
        if (noteParts.length) {
          // to_status is required by schema; progress events mirror the
          // current status so the event stream stays append-only without
          // fabricating a transition.
          store.db.prepare(
            "INSERT INTO events(task_id, from_status, to_status, actor, note, at) VALUES (?, ?, ?, ?, ?, ?)"
          ).run(task.id, task.status, task.status, agentId, noteParts.join(" | "), Date.now());
        }
        const fresh = store.task.get(task.id);
        return ok(JSON.stringify({ ok: true, task: { id: fresh.id, status: fresh.status, last_heartbeat: fresh.last_heartbeat, attempt_count: fresh.attempt_count } }), { status: "ok", taskId: task.id, agentId, budget: { toolCalls: budget.tool_calls, limit: budget.limit_calls, exhausted: budget.exhausted } });
      } catch (e) {
        return err(`backlog_update failed: ${e?.message}`, "error");
      }
    },

    async backlog_done(args, identity) {
      const agentId = identity.agent;
      const budget = chargeBudget(identity);
      const task = store.task.get(args?.taskId);
      if (!task) return err(`backlog_done: not found: ${args?.taskId}`, "not_found");
      if (task.status !== "in_progress") return err(`${task.id} is ${task.status}, not in_progress.`, "not_claimed", { taskId: task.id });
      if (task.assigned !== agentId) return err(`${task.id} is assigned to ${task.assigned}, not ${agentId}.`, "not_assignee", { taskId: task.id });
      try {
        const summary = clampNote(args.resultSummary, 4000);
        const artifacts = Array.isArray(args.artifacts) ? args.artifacts.slice(0, 50) : [];
        const resultSummary = artifacts.length ? `${summary}\n\nartifacts: ${artifacts.join(", ")}` : summary;
        const updated = store.task.update(task.id, { status: "done", result_summary: resultSummary, actor: agentId, note: "done" });
        logger?.info?.(`backlog: ${agentId} completed ${task.id}`);
        return ok(JSON.stringify({ ok: true, task: { id: updated.id, status: updated.status, result_summary: updated.result_summary } }), { status: "ok", taskId: task.id, agentId, budget: { toolCalls: budget.tool_calls, limit: budget.limit_calls, exhausted: budget.exhausted } });
      } catch (e) {
        return err(`backlog_done failed: ${e?.message}`, "error");
      }
    },

    async backlog_block(args, identity) {
      const agentId = identity.agent;
      const budget = chargeBudget(identity);
      const task = store.task.get(args?.taskId);
      if (!task) return err(`backlog_block: not found: ${args?.taskId}`, "not_found");
      if (task.assigned && task.assigned !== agentId) return err(`${task.id} is assigned to ${task.assigned}, not ${agentId}.`, "not_assignee", { taskId: task.id });
      if (task.status !== "in_progress" && task.status !== "todo") return err(`${task.id} is ${task.status}; blocking applies to todo/in_progress only.`, "wrong_status", { taskId: task.id });
      try {
        const reason = clampNote(args.reason, 1000);
        let updated;
        if (args?.gateType) {
          // Human gates open through openGate, not the generic update path:
          // same-transaction `gate open:` event, canonical note vocabulary,
          // exactly-once CAS. The generic path stays for plain blocks.
          updated = store.task.openGate({ id: task.id, gateType: args.gateType, reason, actor: agentId });
          if (!updated) return err(`${task.id} is ${store.task.get(task.id)?.status ?? "gone"}; gating applies to todo/in_progress only.`, "wrong_status", { taskId: task.id });
        } else {
          updated = store.task.update(task.id, { status: "blocked", actor: agentId, note: `blocked: ${reason}` });
        }
        let depResult = null;
        if (args?.blockedBy) {
          const r = addDep(store, task.id, args.blockedBy.id);
          depResult = r.ok ? "added" : `failed:${r.code}`;
          if (r.ok) {
            store.db.prepare(
              "INSERT INTO events(task_id, from_status, to_status, actor, note, at) VALUES (?, ?, ?, ?, ?, ?)"
            ).run(task.id, "blocked", "blocked", agentId, `dep: ${task.id} depends on ${args.blockedBy.id}`, Date.now());
          }
        }
        logger?.warn?.(`backlog: ${agentId} blocked ${task.id} (${reason})`);
        return ok(JSON.stringify({ ok: true, task: { id: updated.id, status: updated.status }, dep: depResult }), { status: "ok", taskId: task.id, agentId, dep: depResult, budget: { toolCalls: budget.tool_calls, limit: budget.limit_calls, exhausted: budget.exhausted } });
      } catch (e) {
        return err(`backlog_block failed: ${e?.message}`, "error");
      }
    },

    async backlog_resume(args, identity) {
      const actor = args?.actor ?? identity.agent;
      const task = store.task.resumeGate({ id: args?.taskId, actor });
      if (!task) {
        // Name the common false alarm: the task was gated before (a gate
        // note sits in its trail) but the gate has since dissolved — e.g. an
        // unmerged close requeued it. The operator approved something real;
        // "not resumable" alone would read as operator error.
        const current = args?.taskId ? store.task.get(args.taskId) : null;
        const lastGate = current && store.db.prepare(
          "SELECT note FROM events WHERE task_id=? AND (note LIKE 'gate open:%' OR note='gate resume') ORDER BY id DESC LIMIT 1"
        ).get(current.id);
        // An opened-but-never-resolved gate on a non-blocked task dissolved
        // without approval — e.g. an unmerged close requeued it. A trailing
        // 'gate resume' is the opposite: already resolved, plain not_resumable.
        if (lastGate && lastGate.note.startsWith("gate open:")) return err(`backlog_resume: ${current.id} was gated but the gate has dissolved (status ${current.status}) — nothing to resume; re-gate with backlog_block if approval is still needed.`, "gate_dissolved", { taskId: current.id, taskStatus: current.status });
        return err(`backlog_resume: not resumable: ${args?.taskId}`, "not_resumable", { taskId: args?.taskId ?? null });
      }
      logger?.info?.(`backlog: ${actor} resumed ${task.id}`);
      return ok(JSON.stringify({ ok: true, task: { id: task.id, status: task.status, gate_type: task.gate_type, assigned: task.assigned } }), { status: "ok", taskId: task.id, actor });
    },
  };

  async function handle(name, args, identity) {
    assertCleanTriple(identity, `caller identity for ${name}`);
    const fn = handlers[name];
    if (!fn) return err(`unknown tool: ${name}`, "unknown_tool");
    return fn(args, identity);
  }

  return { TOOL_DEFS, handle };
}
