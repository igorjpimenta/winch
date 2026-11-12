// index.js — assembles the tool surface. Identity is never a tool param: the
// caller comes from the resolved identity, so no agent can act as another.
//
// Claim semantics are the store's CAS (`status='todo' AND (assigned IS NULL
// OR assigned=?)`): a race loser gets `claim === null` and moves on. There is
// no blocking wait inside a tool call.

import { assertCleanTriple, resolveUsage, identitySessionKey } from "../identity.js";
import { resolveRequestConfig } from "../config.js";
import { TOOL_DEFS } from "./definitions.js";
import { err } from "./shared.js";
import { createClaimTools } from "./claim.js";
import { createAssignTools } from "./assign.js";
import { createPlanTools } from "./plan.js";
import { createReadTools } from "./read.js";
import { createReportTools } from "./report.js";
import { createUsageTools } from "./usage.js";

export { TOOL_DEFS } from "./definitions.js";
export { collectStoryArtifacts, renderReceiverPrompt } from "./shared.js";

export function createToolHandlers(store, logger) {
  const baseConfig = store.config;
  const handlers = {
    ...createClaimTools({ store, logger }),
    ...createAssignTools({ store, logger }),
    ...createPlanTools({ store, logger }),
    ...createReadTools({ store, logger }),
    ...createReportTools({ store, logger }),
    ...createUsageTools({ store, logger }),
  };

  async function handle(name, args, identity, meta = null) {
    assertCleanTriple(identity, `caller identity for ${name}`);
    const cfg = resolveRequestConfig(baseConfig, meta);
    // Optional cost tracking: opportunistically record usage stamped by a
    // companion plugin on the trusted meta/args channel. Never required, never
    // fatal — a recording failure must not break the tool call.
    if (cfg.costTracking !== false) {
      try {
        const usage = resolveUsage({ meta, args });
      if (usage) {
        // Attribute usage to whatever work item this call touches — not just
        // tasks. All work (epics, stories, tasks, plans) consumes tokens.
        let itemId = typeof args?.taskId === "string" ? args.taskId
          : typeof args?.task_id === "string" ? args.task_id
          : typeof args?.id === "string" ? args.id
          : typeof args?.epicId === "string" ? args.epicId
          : typeof args?.epic_id === "string" ? args.epic_id
          : typeof args?.storyId === "string" ? args.storyId
          : typeof args?.story_id === "string" ? args.story_id
          : null;
        let bound = null;
        const fromArgs = !!itemId;
        if (!itemId) {
          try { bound = store.session?.get?.(identitySessionKey(identity)); } catch { bound = null; }
          if (bound?.itemId) itemId = bound.itemId;
        }
        // Implicit bind (option C): any call that names an item binds the
        // session to it, so subsequent calls without an item id attribute
        // to the last-touched item. Only bind when the id came from args,
        // so a bound fallback does not re-bind to itself.
        if (fromArgs && itemId) {
          let ik = null;
          if (itemId.startsWith("EPIC-")) ik = "epic";
          else if (itemId.startsWith("STORY-")) ik = "story";
          else if (itemId.startsWith("TASK-")) ik = "task";
          else ik = "item";
          try { store.session?.bind?.(identitySessionKey(identity), itemId, ik); } catch { /* ignore */ }
        }
        let itemKind = null;
        if (itemId) {
          if (bound?.itemKind) itemKind = bound.itemKind;
          else if (itemId.startsWith("EPIC-")) itemKind = "epic";
          else if (itemId.startsWith("STORY-")) itemKind = "story";
          else if (itemId.startsWith("TASK-")) itemKind = "task";
          else itemKind = "item";
        }
        store.usage.record({
          harness: identity.harness,
          agent: identity.agent,
          session: identity.session,
          itemId,
          itemKind,
          usage,
          source: "meta",
        });
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
