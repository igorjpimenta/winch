// Story facade: a story belongs to an epic and fans out into tasks.

export function createStoryApi({ core, apis }) {
  const { db } = core;

  return {
    create({ epicId, title, description, acceptance, status, size, priority, assigned, capabilities, assigneeHarness, id }) {
      if (!apis.epic.get(epicId)) throw new Error(`epic not found: ${epicId}`);
      return apis.item.create({
        id, kind: "story", parentId: epicId, title, description, acceptance,
        status, size, priority, capabilities,
        assigneeAgent: assigned ?? null,
        assigneeHarness: assigned ? (assigneeHarness ?? "legacy") : null,
        emit: false,
      });
    },
    get(id) {
      const row = apis.item.get(id);
      return row?.kind === "story" ? row : null;
    },
    list({ epicId, status, assigned, assignedHarness } = {}) {
      return apis.item.list({ kind: "story", parentId: epicId, status, assigned, assignedHarness });
    },
    update(id, patch) {
      const existing = apis.story.get(id);
      if (!existing) throw new Error(`story not found: ${id}`);
      const next = { ...patch };
      if (patch.assignee_harness !== undefined) next.assigneeHarness = patch.assignee_harness;
      if (patch.assigned !== undefined) next.assigneeAgent = patch.assigned ?? null;
      return apis.item.update(id, next);
    },
    delete(id) {
      const r = db.prepare("DELETE FROM items WHERE id=? AND kind='story'").run(id);
      return r.changes > 0;
    },
  };
}
