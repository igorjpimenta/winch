# Lifecycle

A task moves from `ready` through a claim to `done`. A block parks it until an
operator resumes it; closing the last task closes its story, and the last story
closes the epic.

## Task lifecycle

```mermaid
flowchart LR
  A[ready] -->|claim by id or next| B[in_progress]
  B -->|heartbeat / update| B
  B -->|lease expires| A
  B -->|done| C[done]
  B -->|block| D[blocked]
  D -->|resume| A
  C -->|last task| E[story done]
  E -->|last story| F[epic done]
```

A lease expiry keeps the assignee so a dispatcher can re-wake the same worker;
only the status returns to `ready`.

Delegation keeps the accountable on the parent: a child task carries the
worker, the parent depends on it and waits in `blocked`, and the watcher
returns the parent to `ready` for the accountable when every child is
terminal.

## Attempt lifecycle

```mermaid
flowchart TD
  A[claim] --> B[running]
  B -->|heartbeat| B
  B -->|done| C[done]
  B -->|block with gate| D[gated]
  B -->|release / lease expires| E[released]
  B -->|block without gate| E
```

At `MAX_ATTEMPTS` the sweeper blocks the task instead of requeueing it.

## Gate lifecycle

```mermaid
flowchart LR
  A[ready or in_progress] -->|openGate with gateType| B[blocked / gate open]
  B -->|resume| C[ready]
  B -->|caller names another actor| B
  B -->|second resume| X[not_resumable]
  B -->|unmerged PR close| C
```

Claim leases, attempt caps, and gate checks:

- **Claim**: atomic CAS under a lease. Highest-priority ready task selected when no id given. Human work uses the reserved `human` / `human_in_the_loop` pair: it keeps `ready`/`in_progress` but is never claimable by an agent.
- **Dependencies**: forward-only, cycle-checked. Cancelled deps count as resolved.
- **Gates**: `backlog_block` opens a gate when `gateType` is given; `backlog_resume` returns it to `ready` and clears the assignment. A caller that names another actor is refused.
- **Close**: closing the last task closes its story; closing the last story closes the epic and wakes the planner.
- **Starvation**: lives in the watcher manifest (deferred list, per-task idleMs).
- **Lease sweeper**: claims self-heal on next tick when the lease expires without heartbeats.
