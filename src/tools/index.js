// index.js — assembles the tool surface. Identity is never a tool param: the
// caller comes from the resolved identity, so no agent can act as another.
//
// Claim semantics are the store's CAS (`status='todo' AND (assigned IS NULL
// OR assigned=?)`): a race loser gets `claim === null` and moves on. There is
// no blocking wait inside a tool call.

import { assertCleanTriple } from "../identity.js";
import { resolveRequestConfig } from "../config.js";
import { TOOL_DEFS } from "./definitions.js";
import { err } from "./shared.js";
import { createClaimTools } from "./claim.js";
import { createAssignTools } from "./assign.js";
import { createPlanTools } from "./plan.js";
import { createReadTools } from "./read.js";
import { createReportTools } from "./report.js";

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
