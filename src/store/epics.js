// Epic facade: a small vocabulary over the recursive item API.

export function createEpicApi({ core, apis }) {
  const { db } = core;

  return {
    create({ title, description, acceptance, status, ownerTeam, priority, id, createdBy }) {
      return apis.item.create({
        id, kind: "epic", title, description, acceptance,
        status: status ?? "backlog", ownerTeam, priority,
        createdBy, emit: false,
      });
    },
    get(id) {
      const row = apis.item.get(id);
      return row?.kind === "epic" ? row : null;
    },
    list({ status } = {}) {
      return apis.item.list({ kind: "epic", status });
    },
    update(id, patch) {
      const existing = apis.epic.get(id);
      if (!existing) throw new Error(`epic not found: ${id}`);
      return apis.item.update(id, { ...patch, status: patch.status });
    },
    delete(id) {
      const r = db.prepare("DELETE FROM items WHERE id=? AND kind='epic'").run(id);
      return r.changes > 0;
    },
  };
}
