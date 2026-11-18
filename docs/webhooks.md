# Dispatch webhooks

Winch delivers dispatch wakes over HTTP. A receiver answers `202` (or any 2xx)
to accept delivery; the agent's MCP `backlog_claim` remains the work guard, so
duplicate wakes are safe. Routing, backoff and restart recovery live in
[Dispatch and recovery](dispatch.md).

## Registration

Each adapter owns a stable executor id and bearer, persists them, receives
wakes on `POST /wake`, and registers its URL:

    POST /dispatch/register
    {"harness":"openclaw","executorId":"openclaw-…","url":"http://127.0.0.1:18789/api/winch/dispatch","bearer":"…"}

The core stores the target in `dispatch_webhooks`, keyed by
`(harness, executor_id)`. Adapters register themselves; a manually managed
endpoint can be registered or replaced from the CLI:

    winch webhook register --harness H --url U [--id E] [--bearer B] [--timeout-ms N]
    winch webhook list [--harness H]
    winch webhook revoke --harness H --id E
    winch webhook test --harness H [--id E]

`register` derives a stable `manual-<hash>` id from the URL when `--id` is
omitted. If `--bearer` is omitted it generates one and prints it once; later
`list` output redacts it. The bearer is sent as `Authorization: Bearer …` on
every wake.

## Wake payload

Winch POSTs this JSON body:

    {
      "type": "wake",
      "admissionId": "ADM-…",
      "itemId": "TASK-…",
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

`winch webhook test --harness H [--id E]` sends:

    {"type":"ping","harness":"H","executorId":"E","at":1730000000000}

Both bundled receivers answer `200 {"ok":true,"test":true}`. A custom receiver
may do the same, or return any 2xx. The command reports each endpoint's status
and exits non-zero if any endpoint fails.

## Receiver requirements

- Accept `POST` on a stable URL reachable from the winch server.
- Require the executor bearer; reject a mismatched or missing one.
- Return 2xx before starting long work, and deduplicate on `admissionId`.
- Register on boot and re-register after an address change.
- Call `POST /dispatch/recover` on boot; see
  [Restart recovery](dispatch.md#restart-recovery).
