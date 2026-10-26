// tools.js — agent-facing backlog tools: backlog_next / _claim / _update /
// _done / _block / _resume.
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
import { resolveRequestConfig } from "./config.js";
import { notifyClaim, claimPayload } from "./claim-webhook.js";

// Every call that reaches a handler runs. Claim pacing is the store's
// lease plus the watcher's per-agent routing cap; semantic stop stays
// backlog_done.
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
  // One config object governs handlers and store alike: the store resolved
  // it at construction (explicit > env > defaults). Per-call
  // `_meta.winch.config` merges over this base inside handle(), so one
  // harness can tune a single call without touching the server.
  const baseConfig = store.config;
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
      name: "backlog_claim",
      description:
        "Atomically claim ONE specific task by id for THIS agent (identity resolved from request meta / environment). " +
        "Same CAS semantics as backlog_next, but targeted: the task must be todo AND currently ready (deps done, " +
        "caps intersect) — otherwise the call is refused as not_claimed / not_ready, never queued. " +
        "Supports dryRun to report without claiming. A race loser gets `raced`, not a partial claim.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["taskId"],
        properties: {
          taskId: { type: "string", description: "Task id (TASK-…)." },
          capabilities: {
            type: "array",
            items: { type: "string" },
            description: "Capability tags this agent offers; filters tasks whose required caps intersect.",
          },
          dryRun: {
            type: "boolean",
            description: "Report the task (with handoff payload) without claiming it.",
          },
        },
      },
    },
    {
      name: "backlog_assign",
      description:
        "Planner-only: set (or clear) the assignee of a task so the right specialist claims it. " +
        "Gated by the server's assigner allowlist — a caller not on it is refused as not_assigner. " +
        "Refuses to reassign a task that is in_progress by someone else. Passing `agent: null` or \"\" clears it. " +
        "Optional `capabilities` replaces the task's capability tags.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["taskId"],
        properties: {
          taskId: { type: "string", description: "Task id (TASK-…)." },
          agent: { type: ["string", "null"], description: "Target agent id, or null/\"\" to unassign." },
          capabilities: {
            type: "array",
            items: { type: "string" },
            description: "Capability tags the task requires; replaces existing tags.",
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
          actor: { type: "string", description: "Must equal the caller's agent when given; anyone else's name is rejected as actor_mismatch. Defaults to the caller." },
        },
      },
    },
  ];

  const handlers = {
    async backlog_next(args, identity, cfg) {
      const agentId = identity.agent;
      const sessionKey = identitySessionKey(identity);
      try {
        const candidates = readyTasks(store, { agentId, capabilities: args?.capabilities, limit: cfg.candidates });
        if (candidates.length === 0) {
          return ok(JSON.stringify({ empty: true }), { status: "empty", agentId });
        }
        if (args?.dryRun) {
          const c = candidates[0];
          return ok(JSON.stringify({ dryRun: true, task: c.task, story: { id: c.story.id, title: c.story.title, acceptance: c.story.acceptance }, epic: { id: c.epic.id, title: c.epic.title } }), { status: "ok", dryRun: true, agentId });
        }
        for (const c of candidates) {
          const claimed = store.task.claim({ id: c.task.id, agentId, sessionKey, watchdogMs: cfg.leaseSeconds * 1000 });
          if (!claimed) continue; // raced — next candidate
          logger?.info?.(`backlog: ${agentId} claimed ${claimed.id}`);
          const artifacts = collectStoryArtifacts(store, c.story.id);
          const handoff = {
            reason: "ready-queue claim",
            priority: c.story.priority,
            acceptance_criteria: c.story.acceptance,
            artifacts,
            receiverPrompt: renderReceiverPrompt({ task: claimed, story: c.story, epic: c.epic, artifacts }),
          };
          // Push handoff, never gate the claim: notifyClaim resolves
          // {ok:false} (never throws) when unconfigured or unreachable.
          // DB-registered target first, then env-mapped/single-URL config.
          await notifyClaim(
            cfg,
            claimPayload({ task: claimed, story: c.story, epic: c.epic, artifacts, handoff, identity, sessionKey }),
            logger,
            store.webhook.get(identity.harness)
          );
          return ok(
            JSON.stringify({
              task: claimed,
              story: { id: c.story.id, title: c.story.title, acceptance: c.story.acceptance, priority: c.story.priority },
              epic: { id: c.epic.id, title: c.epic.title, priority: c.epic.priority },
              handoff,
            }),
            { status: "ok", agentId, taskId: claimed.id }
          );
        }
        return ok(JSON.stringify({ empty: true, raced: true }), { status: "empty", reason: "all_candidates_raced", agentId });
      } catch (e) {
        logger?.warn?.(`backlog_next failed: ${e?.message}`);
        return err(`backlog_next failed: ${e?.message}`, "error");
      }
    },

    async backlog_claim(args, identity, cfg) {
      const agentId = identity.agent;
      const sessionKey = identitySessionKey(identity);
      const task = store.task.get(args?.taskId);
      if (!task) return err(`backlog_claim: not found: ${args?.taskId}`, "not_found", { taskId: args?.taskId ?? null });
      if (task.status !== "todo") return err(`${task.id} is ${task.status}, not todo — claim applies to todo tasks only.`, "not_claimed", { taskId: task.id });
      try {
        // No limit: an id lookup must not false-negative behind a paging cap.
        const candidates = readyTasks(store, { agentId, capabilities: args?.capabilities });
        const c = candidates.find((cand) => cand.task.id === task.id);
        if (!c) return err(`${task.id} is todo but not currently ready (deps unmet or caps mismatch) — nothing claimed.`, "not_ready", { taskId: task.id });
        if (args?.dryRun) {
          return ok(JSON.stringify({ dryRun: true, task: c.task, story: { id: c.story.id, title: c.story.title, acceptance: c.story.acceptance }, epic: { id: c.epic.id, title: c.epic.title } }), { status: "ok", dryRun: true, agentId, taskId: task.id });
        }
        const claimed = store.task.claim({ id: c.task.id, agentId, sessionKey, watchdogMs: cfg.leaseSeconds * 1000 });
        if (!claimed) return ok(JSON.stringify({ empty: true, raced: true }), { status: "empty", reason: "claim_raced", agentId, taskId: task.id });
        logger?.info?.(`backlog: ${agentId} claimed ${claimed.id} by id`);
        const artifacts = collectStoryArtifacts(store, c.story.id);
        return ok(
          JSON.stringify({
            task: claimed,
            story: { id: c.story.id, title: c.story.title, acceptance: c.story.acceptance, priority: c.story.priority },
            epic: { id: c.epic.id, title: c.epic.title, priority: c.epic.priority },
            handoff: {
              reason: "by-id claim",
              priority: c.story.priority,
              acceptance_criteria: c.story.acceptance,
              artifacts,
              receiverPrompt: renderReceiverPrompt({ task: claimed, story: c.story, epic: c.epic, artifacts }),
            },
          }),
          { status: "ok", agentId, taskId: claimed.id }
        );
      } catch (e) {
        logger?.warn?.(`backlog_claim failed: ${e?.message}`);
        return err(`backlog_claim failed: ${e?.message}`, "error");
      }
    },

    async backlog_assign(args, identity, cfg) {
      // Planner privilege, not a claimant right: the server names who may
      // assign (WINCH_ASSIGNERS). Both bare agent ids and "harness:agent"
      // entries match, so one harness's planner can be named without opening
      // the tool to another harness's agent of the same name.
      const allowed = Array.isArray(cfg.assigners) ? cfg.assigners : [];
      const qualified = `${identity.harness}:${identity.agent}`;
      if (!allowed.includes(identity.agent) && !allowed.includes(qualified)) {
        return err(
          `backlog_assign: ${qualified} is not an assigner (server allows: ${allowed.length ? allowed.join(", ") : "none"}).`,
          "not_assigner",
          { agent: identity.agent }
        );
      }
      const task = store.task.get(args?.taskId);
      if (!task) return err(`backlog_assign: not found: ${args?.taskId}`, "not_found", { taskId: args?.taskId ?? null });
      try {
        const updated = store.task.assign({
          id: task.id,
          agentId: args?.agent ?? null,
          actor: qualified,
          capabilities: args?.capabilities,
        });
        logger?.info?.(`backlog: ${qualified} assigned ${task.id} -> ${updated.assigned ?? "nobody"}`);
        return ok(
          JSON.stringify({ ok: true, task: { id: updated.id, status: updated.status, assigned: updated.assigned, capabilities: updated.capabilities } }),
          { status: "ok", taskId: updated.id, assigned: updated.assigned, agent: identity.agent }
        );
      } catch (e) {
        return err(`backlog_assign failed: ${e?.message}`, "rejected", { taskId: task.id });
      }
    },

    async backlog_update(args, identity, cfg) {
      const agentId = identity.agent;
      const task = store.task.get(args?.taskId);
      if (!task) return err(`backlog_update: not found: ${args?.taskId}`, "not_found");
      if (task.status !== "in_progress") return err(`${task.id} is ${task.status}, not in_progress — claim it with backlog_next first.`, "not_claimed", { taskId: task.id });
      if (task.assigned !== agentId) return err(`${task.id} is assigned to ${task.assigned}, not ${agentId}.`, "not_assignee", { taskId: task.id, assigned: task.assigned });
      try {
        const wantHeartbeat = args?.heartbeat !== false;
        if (wantHeartbeat) store.task.heartbeat(task.id, agentId);
        const noteParts = [];
        if (args?.progressSummary) noteParts.push(`progress: ${clampNote(args.progressSummary, cfg.noteProgressLimit)}`);
        if (args?.comment) noteParts.push(`comment: ${clampNote(args.comment, cfg.noteProgressLimit)}`);
        if (args?.addArtifact) noteParts.push(`artifact: ${clampNote(args.addArtifact, cfg.noteArtifactLimit)}`);
        if (noteParts.length) {
          // to_status is required by schema; progress events mirror the
          // current status so the event stream stays append-only without
          // fabricating a transition.
          store.db.prepare(
            "INSERT INTO events(task_id, from_status, to_status, actor, note, at) VALUES (?, ?, ?, ?, ?, ?)"
          ).run(task.id, task.status, task.status, agentId, noteParts.join(" | "), Date.now());
        }
        const fresh = store.task.get(task.id);
        return ok(JSON.stringify({ ok: true, task: { id: fresh.id, status: fresh.status, last_heartbeat: fresh.last_heartbeat, attempt_count: fresh.attempt_count } }), { status: "ok", taskId: task.id, agentId });
      } catch (e) {
        return err(`backlog_update failed: ${e?.message}`, "error");
      }
    },

    async backlog_done(args, identity, cfg) {
      const agentId = identity.agent;
      const sessionKey = identitySessionKey(identity);
      const task = store.task.get(args?.taskId);
      if (!task) return err(`backlog_done: not found: ${args?.taskId}`, "not_found");
      if (task.status !== "in_progress") return err(`${task.id} is ${task.status}, not in_progress.`, "not_claimed", { taskId: task.id });
      if (task.assigned !== agentId) return err(`${task.id} is assigned to ${task.assigned}, not ${agentId}.`, "not_assignee", { taskId: task.id });
      try {
        const summary = clampNote(args.resultSummary, cfg.noteResultLimit);
        const artifacts = Array.isArray(args.artifacts) ? args.artifacts.slice(0, cfg.maxArtifacts) : [];
        const resultSummary = artifacts.length ? `${summary}\n\nartifacts: ${artifacts.join(", ")}` : summary;
        const updated = store.task.update(task.id, { status: "done", result_summary: resultSummary, actor: agentId, note: "done", sessionKey });
        logger?.info?.(`backlog: ${agentId} completed ${task.id}`);
        return ok(JSON.stringify({ ok: true, task: { id: updated.id, status: updated.status, result_summary: updated.result_summary } }), { status: "ok", taskId: task.id, agentId });
      } catch (e) {
        return err(`backlog_done failed: ${e?.message}`, "error");
      }
    },

    async backlog_block(args, identity, cfg) {
      const agentId = identity.agent;
      const task = store.task.get(args?.taskId);
      if (!task) return err(`backlog_block: not found: ${args?.taskId}`, "not_found");
      if (task.assigned && task.assigned !== agentId) return err(`${task.id} is assigned to ${task.assigned}, not ${agentId}.`, "not_assignee", { taskId: task.id });
      if (task.status !== "in_progress" && task.status !== "todo") return err(`${task.id} is ${task.status}; blocking applies to todo/in_progress only.`, "wrong_status", { taskId: task.id });
      try {
        const reason = clampNote(args.reason, cfg.noteReasonLimit);
        let updated;
        if (args?.gateType) {
          // Human gates open through openGate — the one path that stamps
          // gate.opened rows — never the generic update. Plain blocks keep
          // the generic path and its task.blocked kind.
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
        return ok(JSON.stringify({ ok: true, task: { id: updated.id, status: updated.status }, dep: depResult }), { status: "ok", taskId: task.id, agentId, dep: depResult });
      } catch (e) {
        return err(`backlog_block failed: ${e?.message}`, "error");
      }
    },

    async backlog_resume(args, identity, cfg) {
      // The actor is the caller, never the caller's claim about who acts: a
      // mismatched actor would mint another key's approval on the trail, so
      // the call fails instead. Humans approve through `winch resume --actor`
      // on stdin trust; over MCP there is no speaking for another key.
      if (args?.actor != null && args.actor !== identity.agent) {
        return err(`backlog_resume: refused actor ${JSON.stringify(args.actor)} — approvals record the caller (${identity.agent}).`, "actor_mismatch", { taskId: args?.taskId ?? null });
      }
      const actor = identity.agent;
      const task = store.task.resumeGate({ id: args?.taskId, actor });
      if (!task) {
        // Name the common false alarm: the task was gated before (a gate
        // note sits in its trail) but the gate has since dissolved — e.g. an
        // unmerged close requeued it. The operator approved something real;
        // "not resumable" alone would read as operator error. A trailing
        // 'gate resume' is the opposite case (already resolved), so only an
        // opened-but-never-resolved gate dissolves.
        const current = args?.taskId ? store.task.get(args.taskId) : null;
        const lastGate = current && store.db.prepare(
          "SELECT note FROM events WHERE task_id=? AND (note LIKE 'gate open:%' OR note='gate resume') ORDER BY id DESC LIMIT 1"
        ).get(current.id);
        if (lastGate && lastGate.note.startsWith("gate open:")) return err(`backlog_resume: ${current.id} was gated but the gate has dissolved (status ${current.status}) — nothing to resume; re-gate with backlog_block if approval is still needed.`, "gate_dissolved", { taskId: current.id, taskStatus: current.status });
        return err(`backlog_resume: not resumable: ${args?.taskId}`, "not_resumable", { taskId: args?.taskId ?? null });
      }
      logger?.info?.(`backlog: ${actor} resumed ${task.id}`);
      return ok(JSON.stringify({ ok: true, task: { id: task.id, status: task.status, gate_type: task.gate_type, assigned: task.assigned } }), { status: "ok", taskId: task.id, actor });
    },
  };

  async function handle(name, args, identity, meta = null) {
    assertCleanTriple(identity, `caller identity for ${name}`);
    const cfg = resolveRequestConfig(baseConfig, meta);
    const fn = handlers[name];
    if (!fn) return err(`unknown tool: ${name}`, "unknown_tool");
    return fn(args, identity, cfg);
  }

  return { TOOL_DEFS, handle };
}
