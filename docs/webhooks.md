# Dispatch and wake

`winch serve --ws` is the dispatch channel. With `WINCH_DISPATCH_MODE=core`
(the default), the server owns routing and the one-winner guard:

- The server routes `task.assigned`, `story.assigned`, `task.restored`,
  `task.appended` and `epic.completed` into `admission_queue`.
- Each delivery attempt is an `admission_attempts` row. The server offers the
  queued wake to each connected executor as a `wake` frame. The
  first `wake_accept` wins and receives `wake_granted`; the rest receive
  `wake_taken`. The row becomes `active` when the item is claimed and closes
  when the item closes. Append and review wakes have no claim: acceptance is
  one-shot, and the offer TTL ends the row instead of retrying it.
- A rejected connection, an expired offer, or an accepted wake that is never
  claimed requeues with exponential backoff. The offer TTL, backoff,
  attempts, per-harness cap and global cap are in [Configuration](configuration.md).
- Both adapters send `hello` with an executor id and harness. `dispatchHarness`
  selects the harness name; it must match the harness that claims the work.

`backlog_delegate` can carry `childKey` and `visitSeq`. A retry of the same pair
returns the existing child; a higher `visitSeq` starts a new round. The parent
waits on all children, and the last child offered moves `current_child_key`.
`backlog_append` wakes the epic creator, not the task assignee.

## Legacy claim webhooks

Claim webhooks are the plugin-mode path (`WINCH_DISPATCH_MODE=plugin`). They
notify a harness when work is claimed; the adapter then starts or prompts the
claiming session. Register via:

    winch webhook set --harness H --url U [--bearer B]
    winch webhook list
    winch webhook remove --harness H
    winch webhook test --harness H

OpenClaw receives webhooks at `POST /api/winch/claimed`. Per-harness targets
come from `WINCH_CLAIM_WEBHOOKS` (`{"openclaw":{"url":"...","bearer":"..."}}`)
and fall back to `WINCH_CLAIM_WEBHOOK_URL`.
