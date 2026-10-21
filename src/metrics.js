// metrics.js — per-hop failure reporting from the events log and task rows,
// bucketed into the MAST taxonomy (system design / inter-agent misalignment /
// task verification) that the agent-loop research uses to judge multi-agent
// teams. Categories map only onto evidence our vocabulary actually emits —
// a slot with no signal returns empty with its rationale rather than guessing.

export function failureReport(store, { now = Date.now(), windowMs = 30 * 24 * 3_600_000 } = {}) {
  const since = now - windowMs;

  // system design: coordination machinery gave up — sweeper escalations and
  // latched budget halts are both "the substrate refused the work".
  const systemDesign = store.db.prepare(`
    SELECT ev.id, ev.task_id AS taskId, ev.note, ev.at
      FROM events ev
     WHERE ev.at >= ?
       AND (ev.note = 'blocked: max attempts' OR ev.note LIKE 'session budget exhausted%')
     ORDER BY ev.at DESC
  `).all(since);

  // verification: work had to be released and re-claimed before landing —
  // attempt_count >= 2 means the loop caught something at least once.
  const verification = store.db.prepare(`
    SELECT id, title, attempt_count AS attempts, updated_at AS at
      FROM tasks
     WHERE attempt_count >= 2 AND updated_at >= ?
     ORDER BY attempt_count DESC
  `).all(since);

  // misalignment: handoff/receiver failures. No event vocabulary emits this
  // yet (review-rejection notes arrive with the review pipeline), so the slot
  // is honest-empty rather than inferred from unrelated notes.
  const misalignment = [];

  return {
    window: { since, now, windowMs },
    counts: {
      system_design: systemDesign.length,
      misalignment: misalignment.length,
      verification: verification.length,
    },
    system_design: systemDesign,
    misalignment,
    verification,
    unmapped: ["misalignment: no emitting vocabulary in the current event set"],
  };
}

export function formatFailureReport(r) {
  const c = r.counts;
  return [
    `failure report (window ${new Date(r.window.since).toISOString()} → ${new Date(r.window.now).toISOString()})`,
    `  system_design: ${c.system_design}`,
    `  misalignment:  ${c.misalignment} (unmapped — see report.unmapped)`,
    `  verification:  ${c.verification}`,
    ...r.system_design.map((e) => `  · [system_design] ${e.taskId}: ${e.note}`),
    ...r.verification.map((t) => `  · [verification] ${t.id} attempts=${t.attempts}`),
  ].join("\n");
}

const invokedDirectly = process.argv[1]?.endsWith("metrics.js");
if (invokedDirectly) {
  const { createStore } = await import("./store.js");
  const argv = process.argv.slice(2);
  const wIdx = argv.indexOf("--window-days");
  const store = await createStore();
  try {
    const windowMs = wIdx >= 0 ? Number(argv[wIdx + 1]) * 86_400_000 : undefined;
    const report = failureReport(store, { windowMs });
    console.log(argv.includes("--json") ? JSON.stringify(report, null, 2) : formatFailureReport(report));
  } finally {
    store.close();
  }
}
