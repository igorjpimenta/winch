// usage.js — optional LLM cost/usage reporting.
import { identitySessionKey } from "../identity.js";
import { ok, err } from "./shared.js";

export function createUsageTools({ store, logger }) {
  return {
    async backlog_report_usage(args, identity, cfg) {
      if (cfg.costTracking === false) {
        return err("backlog_report_usage: cost tracking disabled (costTracking=false).", "disabled");
      }
      const harness = identity.harness;
      const agent = identity.agent;
      const session = identity.session;
      // resolve itemId
      let itemId = args?.itemId ?? args?.item_id ?? args?.taskId ?? args?.task_id ?? null;
      let itemKind = args?.itemKind ?? args?.item_kind ?? null;
      if (itemId && !itemKind) {
        if (itemId.startsWith("EPIC-")) itemKind = "epic";
        else if (itemId.startsWith("STORY-")) itemKind = "story";
        else if (itemId.startsWith("TASK-")) itemKind = "task";
        else itemKind = "item";
      }
      // session binding fallback
      if (!itemId) {
        try {
          const sk = identitySessionKey(identity);
          const ws = store.db.prepare("SELECT item_id FROM work_sessions WHERE session_key=? AND ended_at IS NULL").get(sk);
          if (ws?.item_id) {
            itemId = ws.item_id;
            // derive kind
            const it = store.item.get(itemId);
            itemKind = it?.kind ?? itemKind;
          }
        } catch {}
      }
      const usage = {
        model: args?.model ?? null,
        tokensIn: args?.tokensIn ?? args?.tokens_in ?? null,
        tokensOut: args?.tokensOut ?? args?.tokens_out ?? null,
        cacheRead: args?.cacheRead ?? args?.cache_read ?? null,
        costUsd: args?.costUsd ?? args?.cost_usd ?? args?.cost ?? null,
        toolCalls: args?.toolCalls ?? args?.tool_calls ?? null,
      };
      // null out if all null
      if (usage.model === null && usage.tokensIn === null && usage.tokensOut === null &&
          usage.cacheRead === null && usage.costUsd === null && usage.toolCalls === null) {
        return err("backlog_report_usage: no usage data provided.", "invalid");
      }
      try {
        const id = store.usage.record({ harness, agent, session, itemId, itemKind, usage, source: "tool" });
        logger?.info?.(`backlog: usage recorded by ${agent} (${id})`);
        return ok(JSON.stringify({ status: "ok", id, itemId }), { status: "ok", id, itemId });
      } catch (e) {
        return err(`backlog_report_usage failed: ${e?.message}`, "error");
      }
    },
  };
}
