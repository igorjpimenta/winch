// usage.js — optional LLM cost/usage reporting.
import { identitySessionKey } from "../identity.js";
import { classifyId } from "../ids.js";
import { ok, err } from "./shared.js";

function kindOf(id) {
  if (typeof id !== "string") return null;
  const cls = classifyId(id);
  if (cls) return cls; // epic|story|task
  return null;
}

export function createUsageTools({ store, logger }) {
  return {
    async backlog_report_usage(args, identity, cfg) {
      if (cfg?.costTracking === false) {
        return err("backlog_report_usage: cost tracking disabled (costTracking=false).", "disabled");
      }
      const agentId = identity.agent;
      const sessionKey = identitySessionKey(identity);
      const usage = {
        model: typeof args?.model === "string" ? args.model : null,
        tokensIn: typeof args?.tokensIn === "number" ? args.tokensIn : (typeof args?.tokens_in === "number" ? args.tokens_in : null),
        tokensOut: typeof args?.tokensOut === "number" ? args.tokensOut : (typeof args?.tokens_out === "number" ? args.tokens_out : null),
        cacheRead: typeof args?.cacheRead === "number" ? args.cacheRead : (typeof args?.cache_read === "number" ? args.cache_read : null),
        costUsd: typeof args?.costUsd === "number" ? args.costUsd : (typeof args?.cost_usd === "number" ? args.cost_usd : (typeof args?.cost === "number" ? args.cost : null)),
        toolCalls: typeof args?.toolCalls === "number" ? args.toolCalls : (typeof args?.tool_calls === "number" ? args.tool_calls : null),
      };
      // Generalized item attribution: any epic/story/task (or free-form id) can
      // own a usage event — not just tasks, since all work consumes tokens.
      let itemId = typeof args?.itemId === "string" ? args.itemId : (typeof args?.item_id === "string" ? args.item_id : null);
      let itemKind = typeof args?.itemKind === "string" ? args.itemKind : (typeof args?.item_kind === "string" ? args.item_kind : null);
      if (!itemId && typeof args?.taskId === "string") { itemId = args.taskId; itemKind = itemKind ?? "task"; }
      if (!itemId && typeof args?.task_id === "string") { itemId = args.task_id; itemKind = itemKind ?? "task"; }
      if (itemId && !itemKind) itemKind = kindOf(itemId);
      if (itemId && itemKind === "task") {
        const t = store.task.get(itemId);
        if (!t) return err(`backlog_report_usage: not found: ${itemId}`, "not_found");
      } else if (itemId && itemKind === "story") {
        const s = store.story.get(itemId);
        if (!s) return err(`backlog_report_usage: not found: ${itemId}`, "not_found");
      } else if (itemId && itemKind === "epic") {
        const e = store.epic.get(itemId);
        if (!e) return err(`backlog_report_usage: not found: ${itemId}`, "not_found");
      }
      try {
        const id = store.usage.record({
          harness: identity.harness,
          agent: identity.agent,
          session: identity.session,
          itemId,
          itemKind,
          taskId: itemKind === "task" ? itemId : null,
          usage,
          source: "tool",
        });
        logger?.info?.(`backlog: usage recorded by ${agentId} (${id})`);
        return ok(JSON.stringify({ ok: true, id, identity: sessionKey, item: itemId ? `${itemKind ?? "?"}:${itemId}` : null }), { status: "ok", id, agentId });
      } catch (e) {
        return err(`backlog_report_usage failed: ${e?.message}`, "error");
      }
    },
  };
}
