// shared.js — the pieces every tool handler needs: result shapes, note
// clamping, and the store-derived handoff text.

export function ok(text, details) {
  return { content: [{ type: "text", text }], details };
}

export function err(text, reason, extra = {}) {
  return { content: [{ type: "text", text }], details: { status: "rejected", reason, ...extra } };
}

export function clampNote(s, max = 2000) {
  if (typeof s !== "string") return null;
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// Artifacts upstream tasks recorded on this story: addArtifact events plus
// done-result artifact lists, deduped. Everything read is a store row.
export function collectStoryArtifacts(store, storyId) {
  const out = new Set();
  for (const t of store.task.list({ storyId })) {
    const evs = store.db.prepare("SELECT note FROM events WHERE task_id=? AND note LIKE 'artifact:%'").all(t.id);
    for (const e of evs) out.add(e.note.slice("artifact: ".length).trim());
    const m = t.result_summary ? t.result_summary.match(/\nartifacts: (.+)$/) : null;
    if (m) for (const a of m[1].split(",")) out.add(a.trim());
  }
  return [...out];
}

// Rendered exclusively from store rows (task/story/epic/artifact events).
// No session history, call params, or conversation content can enter this
// string — that is the handoff contract: a receiver prompt is a projection
// of the store, nothing else.
export function renderReceiverPrompt({ task, story, epic, artifacts }) {
  const parts = [
    `# Task: ${task.title}`,
    task.description ? `## Context\n${task.description}` : null,
    `## Acceptance\n${story.acceptance ?? "(none recorded)"}`,
    `## Upstream artifacts\n${artifacts.length ? artifacts.map((a) => `- ${a}`).join("\n") : "(none yet)"}`,
    `## Parent\n${epic.title} — ${story.title}`,
  ];
  return parts.filter(Boolean).join("\n\n");
}
