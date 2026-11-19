# WebSocket event stream

`winch serve --ws [--port N] [--host H]` tails the `item_events` ledger and
broadcasts new rows to every connected client as JSON text frames. The stream
is read-only: clients observe, they do not claim or dispatch work.

Dispatch runs in a separate process, `winch webhook serve`. Wakes are not frames
on this socket; their contract is in [Webhooks](webhooks.md).

## Connection

The default port is `38291`, and the default bind address is `127.0.0.1`.
`--host` widens the bind; there is no in-process authentication, so keep it on
localhost or put a bearer-checked reverse proxy in front.

A client connects over RFC 6455 and receives three frame types:

1. `{"type":"welcome","payload":"v3","lastEventId":N}` on connect.
2. `{"type":"history","events":[...]}` with up to
   `WINCH_WS_HISTORY_LIMIT` recent envelopes, oldest-first.
3. `{"type":"event",...}` for each new row, in id order.

History and live frames share one envelope shape:

```json
{
  "type": "event",
  "kind": "task.completed",
  "id": 42,
  "at": 1729999880000,
  "fromStatus": "in_progress",
  "toStatus": "done",
  "item": {
    "id": "TASK-…",
    "kind": "task",
    "title": "…",
    "status": "done",
    "assigned": "worker",
    "assigneeHarness": "openclaw",
    "createdBy": "planner"
  },
  "epicId": "EPIC-…",
  "epicCreatedBy": "planner",
  "epicAssigneeHarness": "openclaw",
  "storyId": "STORY-…",
  "storyAssigned": "worker",
  "storyAssigneeHarness": "openclaw",
  "unblocked": [],
  "task": {
    "id": "TASK-…",
    "title": "…",
    "story": "…",
    "epic": "…",
    "acceptance": "…",
    "artifacts": [],
    "assignee": "worker"
  },
  "actor": "worker",
  "actorHarness": "openclaw",
  "note": "…"
}
```

Fields that do not apply to a row are `null` or empty. `unblocked` carries work
that a close made structurally claimable, so an observer can react without
recomputing the dependency graph.

## Kinds

The producer declares `kind` at write time and it is stored on the row; a
stored kind wins over structural inference. Structural inference covers `task.*`
and `gate.*`; producers also write `story.assigned`, `deps.*`, and
`release.shipped`.
Notes are free text and never classify anything, so renaming a note cannot
rewrite history. Structural inference lives in `src/events-ws.js`.

## Reconnect and retention

The stream is a feed, not a queue. Clients dedupe by `id` and keep their own
cursor; a reconnect replays the bounded history window, so a missed frame costs
a re-read rather than silent loss. If you need every event forever, persist the
ledger rather than relying on the socket.

## Server duties

The WebSocket service polls for new rows on `WINCH_WS_INTERVAL_MS` and does
nothing else. Queue delivery, registration, recovery and lease sweeping belong
to `winch webhook serve`; see [Webhooks](webhooks.md).

`winch watch` remains the one-shot tick for hosts that do not run the dispatch
service. Claims still self-heal on the next tick when the database lives
elsewhere.

## Configuration

| setting | environment | default |
|---|---|---|
| port | `WINCH_WS_PORT` | `38291` |
| history size | `WINCH_WS_HISTORY_LIMIT` | `200` |
| poll interval | `WINCH_WS_INTERVAL_MS` | `1000` ms |
