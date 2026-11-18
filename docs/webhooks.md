# Webhooks

Winch stores webhook subscriptions by topic and stable id. Dispatch is the
built-in topic: it delivers wake frames over HTTP, and a receiver answers `202`
(or any 2xx) to accept delivery. The agent's MCP `backlog_claim` remains the
work guard, so duplicate wakes are safe.

`winch webhook serve [--port N] [--host H]` starts the HTTP dispatch endpoints
and the wake pump. It is separate from `winch serve --ws`, which serves only the
read-only event stream; that contract is in [WebSocket event
stream](websocket.md).

## Subscriptions

The core stores subscriptions in `webhooks`, keyed by `(topic, id)`.
`harness` and `executor_id` are optional target metadata, so one id can carry
independent endpoints for different purposes.

    winch webhook bearer
    winch webhook register --topic T [--harness H] [--executor E] --url U [--id I] [--bearer B] [--timeout-ms N]
    winch webhook list [--topic T] [--harness H]
    winch webhook revoke [--topic T] --id I
    winch webhook test [--topic T] [--harness H] [--id I]

`register` defaults to `--topic dispatch`. It derives a stable `manual-<hash>`
id from the URL when `--id` is omitted. For the dispatch topic, the executor id
defaults to the subscription id and `--harness` is required. If `--bearer` is
omitted it uses `WINCH_WEBHOOK_BEARER`, then generates one and prints it once;
later `list` output redacts it. The bearer is sent as
`Authorization: Bearer …` on every delivery.

`list` shows every topic unless `--topic` is given. `revoke` and `test` default
to `dispatch`; `test` pings every subscription in the selected topic or id.

## Serving

The dispatch server listens on `WINCH_DISPATCH_PORT` (default `38293`) and
localhost-only unless `--host` says otherwise:

    winch webhook serve [--port N] [--host H]

It also sweeps expired leases on `WINCH_DISPATCH_SWEEP_MS`. The read-only
event stream is a separate process: `winch serve --ws`.

## Live enqueue

A status transition writes its wake rows into `admission_queue` inside the same
SQLite transaction as `item_state` and `item_events`. The writer then posts to
`/dispatch/notify` on the dispatch base URL (`WINCH_DISPATCH_URL`, default
`http://127.0.0.1:38293`) so the dispatcher drains immediately. The
notification is best-effort; the queue is durable. On startup the dispatcher
replays `item_events` to repair queues written before this path existed, and
`enqueue` deduplicates by event id. The interval pump remains only for offer
expiry, retry backoff and lost notifications.

## Dispatch registration

Each adapter exposes one wake route for its consumer and registers it on the
`dispatch` topic. The event's `kind` decides what the listener does; the
executor is metadata, so a consumer never needs a second webhook:

    POST /dispatch/register
    {"harness":"openclaw","consumerId":"openclaw:host","executorId":"openclaw-1","url":"http://127.0.0.1:18789/api/winch/dispatch","bearer":"…"}

`consumerId` is the webhook identity; `executorId` is the live connection.
Re-registering a consumer replaces its URL and refreshes `lastSeenAt`. Adapters
re-register on every reconcile; the server drops a dispatch webhook whose
`lastSeenAt` is older than `WINCH_DISPATCH_CONSUMER_TTL_MS` (default 90s). A
`404` or `410` from a wake URL drops that row immediately. A legacy
executor-keyed row for the same executor is removed on the first consumer
registration. Multiple consumers may share a harness; each gets the wake.

The adapter environment supplies the identity:

| variable | meaning |
|---|---|
| `WINCH_HARNESS` | harness name; must match the MCP connection |
| `WINCH_CONSUMER_ID` | stable consumer id; default `harness:hostname` |
| `WINCH_EXECUTOR_ID` | unique id for this live connection |
| `WINCH_WEBHOOK_BEARER` | receiver token; generate with `winch webhook bearer` |
| `WINCH_DISPATCH_URL` | winch base URL, default `http://127.0.0.1:38293` |

Adapters fail closed when `WINCH_EXECUTOR_ID` or `WINCH_WEBHOOK_BEARER` is
missing. Plugin config can supply `winchHarness`, `winchConsumerId`, and
`winchExecutorId`; the environment is the fallback.

## Dispatch routing

The server routes `task.assigned`, `story.assigned`, `task.restored`,
`task.appended` and `epic.completed` into `admission_queue`.

- Each delivery attempt is an `admission_attempts` row. A queued wake is
  POSTed to every dispatch subscription for its harness. `202` means the
  receiver accepted the request; it does **not** mean the work was claimed.
- Every consumer receives the wake. Each receiver deduplicates on
  `admissionId + attemptNo`, then starts its session; the agent's MCP
  `backlog_claim` is the one-winner guard, so losers stop without handling the
  item. The winning claim records `consumerId` on the admission attempt.
- The row becomes `active` when the item is claimed and closes when the item
  closes. Append and review wakes have no claim: one successful delivery is
  one-shot, and the offer TTL ends the row instead of retrying it.
- A failed delivery, an expired offer, or a wake that is never claimed
  requeues with exponential backoff. Offer TTL, backoff, attempts, per-harness
  cap and global cap are in [Configuration](configuration.md).

## Wake payload

Winch POSTs this JSON body:

    {
      "type": "wake",
      "admissionId": "ADM-…",
      "itemId": "TASK-…",
      "attemptNo": 1,
      "kind": "task",
      "harness": "openclaw",
      "agent": "worker",
      "eventId": 42,
      "offerExpiresAt": 1730000000000,
      "at": 1729999880000
    }

The receiver should verify the bearer, keep the request bounded, and return 2xx
once the wake is queued locally. A non-2xx response requeues delivery with
backoff. The payload is a pointer, not a brief: the agent reads the record with
`backlog_get` and wins the work with `backlog_claim`.

## Testing

`winch webhook test --topic T [--harness H] [--id I]` sends:

    {"type":"ping","topic":"T","id":"I","harness":"H","executorId":"E","at":1730000000000}

Both bundled receivers answer `200 {"ok":true,"test":true}`. A custom receiver
may do the same, or return any 2xx. The command reports each subscription's
status and exits non-zero if any fails.

## Restart recovery

`POST /dispatch/recover` is the consumer-owned reconciler:

    POST /dispatch/recover
    {"harness":"openclaw","consumerId":"openclaw:host","executorId":"openclaw-1"}

It returns:

- `resume`: assigned `in_progress` work with `task`, `attemptId`,
  `sessionId`, `sessionKey`, and `leaseExpiresAt`. The winning claim records
  the consumer; only that consumer gets its resume. Legacy active rows with no
  recorded consumer are returned to the requester;
- `start`: already-offered wakes plus queued wakes admitted into free slots; a
  consumer deduplicates them by `admissionId + attemptNo`. If
  existing offers exceed a cap (for example after a cap is lowered), the oldest
  offers are kept and the newest return to `queued` before the free-slot fill;
- `free`: remaining capacity after active and offered work.

The harness resumes the same attempt, never re-claims an `in_progress` item.
Its first action is `backlog_update` with the returned `attemptId`; a stale
attempt gets `stale_claim`. Only an expired lease returns the item to `ready`,
where normal wake and claim apply.

## Receiver requirements

- Accept `POST` on a stable URL reachable from the winch server.
- Require the executor bearer; reject a mismatched or missing one.
- Deduplicate on `admissionId` + `attemptNo`; a duplicate wake must not start
  a second local session.
- Register on boot and re-register on every reconcile so the heartbeat stays
  fresh. Call `POST /dispatch/recover` after registering.

## Delegation

`backlog_delegate` can carry `childKey` and `visitSeq`. A retry of the same pair
returns the existing child; a higher `visitSeq` starts a new round. The parent
waits on all children, and the last child offered moves `current_child_key`.
`backlog_append` wakes the epic creator, not the task assignee.
