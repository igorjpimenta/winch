// Durable dispatch events: one immutable row per admission attempt. Delivery
// rows point at this event, so a retry keeps the same identity even when the
// admission attempt is re-queued.

export function createDispatchEventApi({ core }) {
  const { db, now, jsonIn, jsonOut } = core;

  function idFor(admissionId, attemptNo) {
    return `${admissionId}:${attemptNo}`;
  }

  return {
    ensure({ admissionId, attemptNo, itemId, sourceEventId = null, payload = {}, at = now() }) {
      const id = idFor(admissionId, attemptNo);
      db.prepare(`
        INSERT INTO dispatch_events(id, admission_id, attempt_no, item_id, source_event_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(admission_id, attempt_no) DO NOTHING
      `).run(id, admissionId, attemptNo, itemId, sourceEventId, jsonOut(payload), at);
      return this.get({ admissionId, attemptNo });
    },

    get({ admissionId, attemptNo }) {
      const row = db.prepare(`
        SELECT * FROM dispatch_events WHERE admission_id=? AND attempt_no=?
      `).get(admissionId, attemptNo);
      return row ? { ...row, payload_json: jsonIn(row.payload_json) ?? {} } : null;
    },

    markPublished({ admissionId, attemptNo, at = now() }) {
      db.prepare(`
        UPDATE dispatch_events SET published_at=COALESCE(published_at, ?)
         WHERE admission_id=? AND attempt_no=?
      `).run(at, admissionId, attemptNo);
      return this.get({ admissionId, attemptNo });
    },
  };
}
