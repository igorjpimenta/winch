// usage.js — LLM cost/usage tracking on top of the v8 ledger.
//
// One append-only `usage_events` row per reported turn. The row carries the
// identity triple denormalized (so it survives session deletion), an item_id
// attribution and optional session/attempt links. Aggregations read this table
// directly; there is no rollup.

export function createUsageApi({ core }) {
  const { db, now } = core;

  function record({
    harness, agent, session, itemId,
    sessionId = null, attemptId = null,
    usage, source = "api", turnRef = null, at = null,
  }) {
    if (!usage || !itemId) return null;
    const u = usage;
    const r = db.prepare(`
      INSERT OR IGNORE INTO usage_events(
        item_id, session_id, attempt_id, harness, agent_id, external_session_id,
        model, tokens_in, tokens_out, cache_read, cost_usd, tool_calls,
        source, turn_ref, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      itemId, sessionId, attemptId, harness, agent, session,
      u.model ?? null, u.tokensIn ?? null, u.tokensOut ?? null, u.cacheRead ?? null,
      u.costUsd ?? null, u.toolCalls ?? null, source ?? "api", turnRef, at ?? now(),
    );
    return r.changes ? Number(r.lastInsertRowid) : null;
  }

  function whereClause({ itemId, harness, agent, session, model, since } = {}) {
    const where = [];
    const args = [];
    if (itemId)  { where.push("item_id=?"); args.push(itemId); }
    if (harness) { where.push("harness=?"); args.push(harness); }
    if (agent)   { where.push("agent_id=?"); args.push(agent); }
    if (session) { where.push("external_session_id=?"); args.push(session); }
    if (model)   { where.push("model=?"); args.push(model); }
    if (since)   { where.push("created_at>=?"); args.push(since); }
    return { where, args };
  }

  function list(opts = {}) {
    const { where, args } = whereClause(opts);
    const sql = `SELECT u.*, i.kind AS item_kind
                   FROM usage_events u JOIN items i ON i.id=u.item_id
                  ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                  ORDER BY u.created_at DESC`;
    return db.prepare(sql).all(...args).map((r) => ({
      id: r.id,
      itemId: r.item_id,
      itemKind: r.item_kind,
      sessionId: r.session_id,
      attemptId: r.attempt_id,
      harness: r.harness,
      agentId: r.agent_id,
      externalSessionId: r.external_session_id,
      model: r.model,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      cacheRead: r.cache_read,
      costUsd: r.cost_usd,
      toolCalls: r.tool_calls,
      source: r.source,
      turnRef: r.turn_ref,
      at: r.created_at,
    }));
  }

  function summary(opts = {}) {
    const { where, args } = whereClause(opts);
    const sql = `SELECT COUNT(*) AS calls,
                        COALESCE(SUM(tokens_in),0) AS tokens_in,
                        COALESCE(SUM(tokens_out),0) AS tokens_out,
                        COALESCE(SUM(cache_read),0) AS cache_read,
                        COALESCE(SUM(cost_usd),0) AS cost_usd,
                        COALESCE(SUM(tool_calls),0) AS tool_calls
                   FROM usage_events
                  ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    return db.prepare(sql).get(...args);
  }

  return { record, list, summary };
}
