// Edges between items. Only `depends_on` is used today, but the kind is part
// of the primary key so other edge kinds can be added without a migration.

export function createDepApi({ core }) {
  const { db, now } = core;

  const row = (r) => r ? {
    from_id: r.from_item_id, from_kind: r.from_kind,
    to_id: r.to_item_id, to_kind: r.to_kind,
    created_at: r.created_at, kind: r.kind,
  } : null;

  const depApi = {
    addRaw({ fromId, toId, kind = "depends_on" }) {
      db.prepare(`
        INSERT INTO item_edges(from_item_id, to_item_id, kind, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(from_item_id, to_item_id, kind) DO NOTHING
      `).run(fromId, toId, kind, now());
      return depApi.get(fromId, toId);
    },
    get(fromId, toId) {
      const r = db.prepare(`
        SELECT e.from_item_id, e.to_item_id, e.kind, e.created_at,
               fi.kind AS from_kind, ti.kind AS to_kind
          FROM item_edges e
          JOIN items fi ON fi.id=e.from_item_id
          JOIN items ti ON ti.id=e.to_item_id
         WHERE e.from_item_id=? AND e.to_item_id=?
      `).get(fromId, toId);
      return row(r);
    },
    remove({ fromId, toId }) {
      const r = db.prepare("DELETE FROM item_edges WHERE from_item_id=? AND to_item_id=?").run(fromId, toId);
      return r.changes > 0;
    },
    listOutgoing(fromId) {
      return db.prepare(`
        SELECT e.from_item_id, e.to_item_id, e.kind, e.created_at,
               fi.kind AS from_kind, ti.kind AS to_kind
          FROM item_edges e
          JOIN items fi ON fi.id=e.from_item_id
          JOIN items ti ON ti.id=e.to_item_id
         WHERE e.from_item_id=?
      `).all(fromId).map(row);
    },
    listIncoming(toId) {
      return db.prepare(`
        SELECT e.from_item_id, e.to_item_id, e.kind, e.created_at,
               fi.kind AS from_kind, ti.kind AS to_kind
          FROM item_edges e
          JOIN items fi ON fi.id=e.from_item_id
          JOIN items ti ON ti.id=e.to_item_id
         WHERE e.to_item_id=?
      `).all(toId).map(row);
    },
    all() {
      return db.prepare("SELECT * FROM item_edges").all();
    },
  };

  return depApi;
}
