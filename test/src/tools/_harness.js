// _harness.js — shared fixture for the per-module tool tests. Not a test file:
// the runner only picks up *.test.js.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../../../src/store.js";
import { createToolHandlers } from "../../../src/tools/index.js";

export const ATLAS = { harness: "test", agent: "atlas", session: "sess-atlas" };
export const WORKER = { harness: "test", agent: "worker", session: "sess-worker" };

export function makeHarness(prefix = "winch-tools-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const store = createStore({ dbPath: path.join(dir, "store.sqlite") });
  const { handle, TOOL_DEFS } = createToolHandlers(store, null);
  const call = (name, args, identity = ATLAS) => handle(name, args, identity);

  function teardown() {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  function seedReadyTask({ assigned = null, taskStatus = "todo", capabilities = null } = {}) {
    const epic = store.epic.create({ title: "E", status: "planned", priority: 80 });
    const story = store.story.create({ epicId: epic.id, title: "S", status: "ready", acceptance: "AC-1", priority: 70 });
    const task = store.task.create({
      storyId: story.id,
      title: "T",
      status: taskStatus,
      executionKind: "manual",
      assigned,
      capabilities,
    });
    return { epic, story, task };
  }

  return { dir, store, handle, call, TOOL_DEFS, teardown, seedReadyTask };
}
