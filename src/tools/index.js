// index.js — assembles the tool surface. Identity is never a tool param: the
// caller comes from the resolved identity, so no agent can act as another.
//
// Claim semantics are the store's CAS (`status='ready' AND assignee_harness=? AND
// assignee_agent=?`): a race loser gets `claim === null` and moves on. There is
// no blocking wait inside a tool call.

import { assertCleanTriple } from "../identity.js";
import { resolveRequestConfig } from "../config.js";
import { TOOL_DEFS } from "./definitions.js";
import { err } from "./shared.js";
import { createClaimTools } from "./claim.js";
import { createAcceptWakeTools } from "./accept-wake.js";
import { createAssignTools } from "./assign.js";
import { createDelegateTools } from "./delegate.js";
import { createPlanTools } from "./plan.js";
import { createReadTools } from "./read.js";
import { createReportTools } from "./report.js";
import { resolveUsage, identitySessionKey } from "../identity.js";

export { TOOL_DEFS } from "./definitions.js";
export { collectStoryArtifacts, renderReceiverPrompt } from "./shared.js";

export function createToolHandlers(store, logger) {
  const baseConfig = store.config;
  const handlers = {
    ...createClaimTools({ store, logger }),
    ...createAcceptWakeTools({ store, logger }),
    ...createAssignTools({ store, logger }),
    ...createDelegateTools({ store, logger }),
    ...createPlanTools({ store, logger }),
    ...createReadTools({ store, logger }),
    ...createReportTools({ store, logger }),
  };

  async function handle(name, args, identity, meta = null) {
    assertCleanTriple(identity, `caller identity for ${name}`);
    const cfg = resolveRequestConfig(baseConfig, meta);
    // Optional cost tracking: opportunistically record usage stamped by a
    // companion plugin on the trusted meta/args channel. Never required.
    if (cfg.costTracking !== false) {
      try {
        const usage = resolveUsage({ meta, args });
        if (usage) {
          const fromArgs = (typeof args?.taskId === "string" || typeof args?.task_id === "string" ||
            typeof args?.id === "string" || typeof args?.epicId === "string" ||
            typeof args?.epic_id === "string" || typeof args?.storyId === "string" ||
            typeof args?.story_id === "string");
          let itemId = typeof args?.taskId === "string" ? args.taskId
            : typeof args?.task_id === "string" ? args.task_id
            : typeof args?.id === "string" ? args.id
            : typeof args?.epicId === "string" ? args.epicId
            : typeof args?.epic_id === "string" ? args.epic_id
            : typeof args?.storyId === "string" ? args.storyId
            : typeof args?.story_id === "string" ? args.story_id
            : null;
          // Implicit bind (option C): an item-touching call rebinds the
          // session to that item, so later calls without an item id attribute
          // to the last-touched item.
          if (fromArgs && itemId) {
            try { store.session.ensure({ harness: identity.harness, agentId: identity.agent, externalSessionId: identity.session, itemId, kind: "claim" }); } catch {}
          }
          // session binding fallback
          if (!itemId) {
            try {
              const sk = identitySessionKey(identity);
              const ws = store.db.prepare("SELECT item_id FROM work_sessions WHERE session_key=? AND ended_at IS NULL").get(sk);
              if (ws?.item_id) itemId = ws.item_id;
            } catch {}
          }
          let itemKind = null;
          if (itemId) {
            if (itemId.startsWith("EPIC-")) itemKind = "epic";
            else if (itemId.startsWith("STORY-")) itemKind = "story";
            else if (itemId.startsWith("TASK-")) itemKind = "task";
            else itemKind = "item";
          }
          store.usage.record({ harness: identity.harness, agent: identity.agent, session: identity.session, itemId, itemKind, usage, source: "meta" });
        }
      } catch (e) {
        logger?.warn?.(`winch: usage record failed: ${e?.message}`);
      }
    }
    const fn = handlers[name];
    if (!fn) return err(`unknown tool: ${name}`, "unknown_tool");
    return fn(args, identity, cfg);
  }

  return { TOOL_DEFS, handle };
}
