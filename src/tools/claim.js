// claim.js — claim one task by id, or the next ready task for this agent.
import { readyTasks } from "../ready-queue.js";
import { identitySessionKey } from "../identity.js";
import { notifyClaim, claimPayload } from "../claim-webhook.js";
import { ok, err, collectStoryArtifacts, renderReceiverPrompt } from "./shared.js";

export function createClaimTools({ store, logger }) {
  return {
    async backlog_claim(args, identity, cfg) {
      const agentId = identity.agent;
      const sessionKey = identitySessionKey(identity);
      // No id: pull the ready queue for this agent and take the first claim
      // that wins its CAS. A loser moves to the next candidate, never retries
      // the same row.
      if (!args?.taskId) {
        try {
          const candidates = readyTasks(store, { agentId, capabilities: args?.capabilities, limit: cfg.candidates });
          if (candidates.length === 0) {
            return ok(JSON.stringify({ empty: true }), { status: "empty", agentId });
          }
          if (args?.dryRun) {
            const c = candidates[0];
            return ok(JSON.stringify({ dryRun: true, task: c.task, story: { id: c.story.id, title: c.story.title, acceptance: c.story.acceptance }, epic: { id: c.epic.id, title: c.epic.title } }), { status: "ok", dryRun: true, agentId, taskId: c.task.id });
          }
          for (const c of candidates) {
            const claimed = store.task.claim({ id: c.task.id, agentId, sessionKey, watchdogMs: cfg.leaseSeconds * 1000 });
            if (!claimed) continue;
            logger?.info?.(`backlog: ${agentId} claimed ${claimed.id} from the ready queue`);
            const artifacts = collectStoryArtifacts(store, c.story.id);
            const handoff = {
              reason: "ready-queue claim",
              priority: c.story.priority,
              acceptance_criteria: c.story.acceptance,
              artifacts,
              receiverPrompt: renderReceiverPrompt({ task: claimed, story: c.story, epic: c.epic, artifacts }),
            };
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
          logger?.warn?.(`backlog_claim (ready queue) failed: ${e?.message}`);
          return err(`backlog_claim failed: ${e?.message}`, "error");
        }
      }
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
  };
}
