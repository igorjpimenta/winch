// Throwaway stores for the store-module tests. The live
// ~/.winch/store.sqlite is never touched.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../../../src/store/index.js";

export function tempDb(prefix = "winch-store-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, dbPath: path.join(dir, "store.sqlite") };
}

export function makeStore(t) {
  const { dir, dbPath } = tempDb();
  const store = createStore({ dbPath });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

export function seedHierarchy(store) {
  const epic = store.epic.create({ title: "epic" });
  const story = store.story.create({ epicId: epic.id, title: "story", status: "in_progress" });
  const task = store.task.create({ storyId: story.id, title: "task", status: "ready", assigned: "agent-a", assigneeHarness: "system" });
  return { epic, story, task };
}

export function eventsFor(store, itemId) {
  return store.db.prepare("SELECT * FROM item_events WHERE item_id=? ORDER BY id").all(itemId);
}
