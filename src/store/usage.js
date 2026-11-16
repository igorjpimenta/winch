// usage.js — optional LLM cost/usage tracking on top of the v8 ledger.
//
// Usage is recorded as an `item_events` row (kind 'usage.recorded') carrying
// the usage payload in payload_json. This reuses the append-only ledger and
// the WebSocket pipe, so cost data streams to subscribers automatically.

export function createUsageApi({ core }) {
  const { db, appendEvent, now, jsonIn } = core;

  function record({ harness, agent, session, itemId = null, itemKind = null, usage, source = "meta", at = null }) {
    if (!usage) return null;
    const u = usage;
    const when = at ?? now();
    const payload = {
      harness, agent, session,
      model: u.model ?? null,
      tokensIn: u.tokensIn ?? null,
      tokensOut: u.tokensOut ?? null,
      cacheRead: u.cacheRead ?? null,
      costUsd: u.costUsd ?? null,
      toolCalls: u.toolCalls ?? null,
      source: source ?? null,
    };
    const targetItem = itemId || null;
    // If no item bound, attribute to a system item? No — store unattributed
    // usage against the session only: we still record it in item_events with
    // a null item_id is not allowed (item_id NOT NULL). So skip recording
    // when there is no item; usage_events-less. Instead, callers should bind
    // a session first. Return null.
    if (!targetItem) return null;
    const id = appendEvent({
      itemId: targetItem,
      toStatus: "usage",
      kind: "usage.recorded",
      actor: `${harness}:${agent}`,
      note: u.model ? `${u.model}` : "usage",
      payload,
      at: when,
    });
    return id;
  }

  function usageRows({ itemId, itemKind, harness, agent, session, since } = {}) {
    const where = ["e.kind='usage.recorded'"];
    const args = [];
    if (itemId) { where.push("item_id=?"); args.push(itemId); }
    if (harness) { where.push("json_extract(payload_json,'$.harness')=?"); args.push(harness); }
    if (agent) { where.push("json_extract(payload_json,'$.agent')=?"); args.push(agent); }
    if (session) { where.push("json_extract(payload_json,'$.session')=?"); args.push(session); }
    if (since) { where.push("created_at>=?"); args.push(since); }
    const sql = `SELECT e.*, i.kind AS item_kind FROM item_events e JOIN items i ON i.id=e.item_id  WHERE ${where.join(" AND ")} ORDER BY e.id DESC`;
    return db.prepare(sql).all(...args);
  }

  function list(opts = {}) {
    const rows = usageRows(opts);
    return rows.map((r) => {
      let p = null;
      try { p = JSON.parse(r.payload_json); } catch {}
      return {
        id: r.id,
        itemId: r.item_id,
        itemKind: r.item_kind ?? null,
        kind: r.kind,
        at: r.created_at,
        ...(p || {}),
      };
    });
  }

  function summary(opts = {}) {
    const rows = usageRows(opts);
    let calls = 0, tokensIn = 0, tokensOut = 0, cacheRead = 0, costUsd = 0, toolCalls = 0;
    for (const r of rows) {
      let p = null;
      try { p = JSON.parse(r.payload_json); } catch {}
      calls++;
      tokensIn += p?.tokensIn ?? 0;
      tokensOut += p?.tokensOut ?? 0;
      cacheRead += p?.cacheRead ?? 0;
      costUsd += p?.costUsd ?? 0;
      toolCalls += p?.toolCalls ?? 0;
    }
    return { calls, tokens_in: tokensIn, tokens_out: tokensOut, cache_read: cacheRead, cost_usd: costUsd, tool_calls: toolCalls };
  }

  return { record, list, summary };
}
