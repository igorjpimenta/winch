# Dispatch and wake

`winch serve --ws` now serves two things: the read-only event stream and the
HTTP dispatch endpoints. Wakes leave over executor webhooks, not the socket.

- The server routes `task.assigned`, `story.assigned`, `task.restored`,
  `task.appended` and `epic.completed` into `admission_queue`.
- Each delivery attempt is an `admission_attempts` row. A queued wake is
  POSTed to every registered endpoint for its harness. `202` means the
  receiver accepted the request; it does **not** mean the work was claimed.
  The agent's MCP `backlog_claim` is the work guard.
- The row becomes `active` when the item is claimed and closes when the item
  closes. Append and review wakes have no claim: one successful delivery is
  one-shot, and the offer TTL ends the row instead of retrying it.
- A failed delivery, an expired offer, or a wake that is never claimed
  requeues with exponential backoff. Offer TTL, backoff, attempts, per-harness
  cap and global cap are in [Configuration](configuration.md).

## Executor registration

Each adapter owns a stable executor id and bearer, persists them, receives
wakes on `POST /wake`, and registers its URL:

    POST /dispatch/register
    {"harness":"openclaw","executorId":"openclaw-…","url":"http://127.0.0.1:18789/api/winch/dispatch","bearer":"…"}

The core stores the target in `dispatch_webhooks`, keyed by
`(harness, executor_id)`. `winch dispatch list` and
`winch dispatch remove --harness H --executor E` inspect or drop a target.
The bearer is sent as `Authorization: Bearer …` on every wake.

## Restart recovery

`POST /dispatch/recover` is the harness-owned reconciler:

    POST /dispatch/recover
    {"harness":"openclaw","executorId":"openclaw-…"}

It returns:

- `resume`: assigned `in_progress` work with `task`, `attemptId`,
  `sessionId`, `sessionKey`, and `leaseExpiresAt`;
- `start`: already-offered wakes plus queued wakes admitted into free slots;
- `free`: remaining capacity after active and offered work.

The harness resumes the same attempt, never re-claims an `in_progress` item.
Its first action is `backlog_update` with the returned `attemptId`; a stale
attempt gets `stale_claim`. Only an expired lease returns the item to `ready`,
where normal wake and claim apply.

`backlog_delegate` can carry `childKey` and `visitSeq`. A retry of the same pair
returns the existing child; a higher `visitSeq` starts a new round. The parent
waits on all children, and the last child offered moves `current_child_key`.
`backlog_append` wakes the epic creator, not the task assignee.
