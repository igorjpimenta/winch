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

// Artifacts upstream tasks recorded on this story: addArtifact events,
// explicit artifact rows, and done-result artifact lists, deduped.
export function collectStoryArtifacts(store, storyId) {
  const out = new Set();
  const story = store.item.get(storyId);
  if (!story) return [];
  const tasks = store.item.tree(storyId).filter((r) => r.kind === "task");
  for (const t of tasks) {
    for (const e of store.event.listFor(t.id)) {
      if (typeof e.note === "string" && e.note.startsWith("artifact:")) {
        out.add(e.note.slice("artifact:".length).trim());
      }
    }
    for (const a of store.artifact.listFor(t.id)) out.add(a.uri);
    const m = t.result_summary ? t.result_summary.match(/\nartifacts: (.+)$/) : null;
    if (m) for (const a of m[1].split(",")) out.add(a.trim());
  }
  return [...out].filter(Boolean);
}

// Rendered exclusively from store rows (task/story/epic/artifact events).
// No session history, call params, or conversation content can enter this
// string — that is the handoff contract: a receiver prompt is a projection
// of the store, nothing else.
export function renderReceiverPrompt({ task, story, epic, artifacts }) {
  const parts = [
    `# Task: ${task.title}`,
    task.description ? `## Context\n${task.description}` : null,
    `## Acceptance\n${story?.acceptance ?? "(none recorded)"}`,
    `## Upstream artifacts\n${artifacts.length ? artifacts.map((a) => `- ${a}`).join("\n") : "(none yet)"}`,
    `## Parent\n${epic?.title ?? "(none)"} — ${story?.title ?? "(none)"}`,
  ];
  return parts.filter(Boolean).join("\n\n");
}
