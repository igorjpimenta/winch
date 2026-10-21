// rollup.js — dispatch fraction: how much of the claimed work was
// self-dispatched. Claim events carry the claiming session's key
// (events.session_ref); an event without one is an operator/CLI claim.
// Nothing outside the store is read.

const DAY = 86_400_000;

export function dispatchFraction(store, { now = Date.now(), windowMs = 30 * DAY } = {}) {
  const since = now - windowMs;
  const row = store.db.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN session_ref IS NOT NULL THEN 1 ELSE 0 END), 0) AS self
      FROM events
     WHERE note = 'claim' AND at >= ?
  `).get(since);
  const total = row.total ?? 0;
  const self = row.self ?? 0;
  return {
    window: { since, now },
    total,
    selfDispatched: self,
    operatorDispatched: total - self,
    fraction: total > 0 ? self / total : 0,
  };
}

const invokedDirectly = process.argv[1]?.endsWith("rollup.js");
if (invokedDirectly) {
  const { createStore } = await import("./store.js");
  const argv = process.argv.slice(2);
  const num = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? Number(argv[i + 1]) : dflt; };
  const store = await createStore();
  try {
    const windowMs = argv.includes("--window-days") ? num("--window-days", 30) * DAY : undefined;
    console.log(JSON.stringify({ dispatch: dispatchFraction(store, { windowMs }) }, null, 2));
  } finally {
    store.close();
  }
}
