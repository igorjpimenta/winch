// usage.js — optional LLM cost/usage reporting.
import { identitySessionKey } from "../identity.js";
import { ok, err } from "./shared.js";

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
      const taskId = typeof args?.taskId === "string" ? args.taskId : (typeof args?.task_id === "string" ? args.task_id : null);
      if (taskId) {
        const t = store.task.get(taskId);
        if (!t) return err(`backlog_report_usage: not found: ${taskId}`, "not_found");
      }
      try {
        const id = store.usage.record({
          harness: identity.harness,
          agent: identity.agent,
          session: identity.session,
          taskId,
          usage,
          source: "tool",
        });
        logger?.info?.(`backlog: usage recorded by ${agentId} (${id})`);
        return ok(JSON.stringify({ ok: true, id, identity: sessionKey }), { status: "ok", id, agentId });
      } catch (e) {
        return err(`backlog_report_usage failed: ${e?.message}`, "error");
      }
    },
  };
}
