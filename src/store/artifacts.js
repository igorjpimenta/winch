// Artifacts are links (or content-addressed URIs) attached to an item and
// optionally to the attempt that produced them.

import { newArtifactId } from "../ids.js";
import { addDep } from "../deps.js";
import { HUMAN_AGENT, HUMAN_HARNESS } from "../reserved.js";

export function createArtifactApi({ core }) {
  const { db, now } = core;

  return {
    add({ itemId, attemptId = null, kind = "link", uri, sha256 = null, label = null }) {
      if (!uri) throw new Error("artifact requires a uri");
      const id = newArtifactId();
      db.prepare(`
        INSERT INTO artifacts(id, item_id, attempt_id, kind, uri, sha256, label, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(uri) DO NOTHING
      `).run(id, itemId, attemptId, kind, uri, sha256, label, now());
      return db.prepare("SELECT * FROM artifacts WHERE uri=?").get(uri) ?? null;
    },
    listFor(itemId) {
      return db.prepare("SELECT * FROM artifacts WHERE item_id=? AND deleted_at IS NULL ORDER BY created_at ASC").all(itemId);
    },
  };
}

export function inferArtifactKind(uri) {
  if (typeof uri === "string" && /github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/.test(uri)) return "pr";
  return "link";
}

/**
 * Store an artifact; when its kind is human-gated (config hitlArtifactKinds),
 * open the HITL child: a ready task assigned to the reserved human pair,
 * a depends-on edge from the parent, and a deps wait that parks the parent
 * until the child resolves. Idempotent per (parent, kind, uri).
 */
export function attachArtifact(store, { itemId, attemptId = null, kind = "link", uri, sha256 = null, label = null }) {
  const row = store.artifact.add({ itemId, attemptId, kind, uri, sha256, label });
  const hitlKinds = store.config?.hitlArtifactKinds ?? [];
  if (!hitlKinds.includes(kind)) return row;

  const parent = store.task.get(itemId);
  if (!parent) return row;

  const childKey = `hitl:${kind}:${uri}`;
  const parentId = parent.story_id ?? parent.parent_id ?? parent.id;
  let child = store.item.byChild(parentId, childKey, 0);
  if (!child) {
    child = store.task.create({
      storyId: parentId,
      title: `Review & merge: ${label ?? `#${kind} artifact`}`,
      description:
        `Human-in-the-loop artifact (${kind}): ${uri}\n\n` +
        `Parent task: ${parent.id} — ${parent.title}\n` +
        `Close this child once the artifact is resolved (PR merged, release approved, design accepted). The parent cannot close until then.`,
      status: "ready",
      assigned: HUMAN_AGENT,
      assigneeHarness: HUMAN_HARNESS,
      executionKind: "gate",
      childKey,
    });
  }

  const edge = store.dep.get(parent.id, child.id);
  if (!edge) {
    const r = addDep(store, parent.id, child.id);
    if (r.ok) {
      store.event.append({
        itemId: parent.id,
        fromStatus: parent.status,
        toStatus: parent.status,
        actor: "system",
        note: `dep: ${parent.id} depends on HITL ${child.id} (${kind}: ${uri})`,
      });
    }
  }

  const st = store.state.get(parent.id);
  const alreadyWaiting = st?.state_json?.wait?.kind === "deps";
  if (!alreadyWaiting && ["backlog", "ready", "in_progress"].includes(parent.status)) {
    try {
      store.task.blockOnDeps({
        id: parent.id,
        childId: child.id,
        actor: "system",
        note: `waiting on HITL child ${child.id}`,
      });
    } catch {
      // status raced away — the dep edge alone still gates claim/close
    }
  }
  return row;
}
