// Artifacts are links (or content-addressed URIs) attached to an item and
// optionally to the attempt that produced them.

import { newArtifactId } from "../ids.js";

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
