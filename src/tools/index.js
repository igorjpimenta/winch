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
    // Implicit session bind: an item-touching call rebinds the session to
    // that item, so usage pushed later over WebSocket attributes to the
    // last-touched item.
    try {
      const fromArgs = (typeof args?.taskId === "string" || typeof args?.task_id === "string" ||
        typeof args?.id === "string" || typeof args?.epicId === "string" ||
        typeof args?.epic_id === "string" || typeof args?.storyId === "string" ||
        typeof args?.story_id === "string");
      const itemId = fromArgs
        ? (args?.taskId ?? args?.task_id ?? args?.id ?? args?.epicId ?? args?.epic_id ?? args?.storyId ?? args?.story_id)
        : null;
      if (fromArgs && itemId) {
        store.session.ensure({ harness: identity.harness, agentId: identity.agent, externalSessionId: identity.session, itemId, kind: "claim" });
      }
    } catch (e) {
      logger?.warn?.(`winch: session bind failed: ${e?.message}`);
    }
    const fn = handlers[name];
    if (!fn) return err(`unknown tool: ${name}`, "unknown_tool");
    return fn(args, identity, cfg);
  }

  return { TOOL_DEFS, handle };
}
