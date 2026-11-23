// Public event read API. Writers use core.appendEvent; this surface is the
// cursor/history readers used by the event envelope (src/events.js) and tools.

export function createEventApi({ core }) {
  const { db, appendEvent, eventById, eventsFor } = core;

  return {
    append: appendEvent,
    get: eventById,
    listFor: eventsFor,
    lastEventId() {
      return db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM item_events").get().m;
    },
    since(id, limit = 200) {
      return db.prepare("SELECT * FROM item_events WHERE id > ? ORDER BY id LIMIT ?").all(id, limit);
    },
    latest(limit = 200) {
      return db.prepare("SELECT * FROM item_events ORDER BY id DESC LIMIT ?").all(limit).reverse();
    },
  };
}
