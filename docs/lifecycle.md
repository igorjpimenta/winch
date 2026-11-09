# Lifecycle

An order moves from ready through a claim and a running task to review. The
verdict decides where it lands, and resume returns rejected or blocked work to
ready.

## Order lifecycle

```mermaid
flowchart LR
  A[Order created] -->|status ready| B[Ready]
  B -->|claim| C[Claimed]
  C -->|attempt| D[Running]
  D -->|checkpoint / evidence| D
  D -->|done| E[Review]
  D -->|blocked| F[Blocked]
  E -->|approve| G[Approved]
  E -->|reject| B
  F -->|resume| B
```

## Claim lifecycle

```mermaid
flowchart TD
  A[Ready task] -->|claim by id or next| B[Claimed]
  B -->|heartbeat| B
  B -->|update progress| B
  B -->|done| C[Closed]
  B -->|blocked| D[Blocked]
  B -->|lease expires| A
  D -->|resume| A
  C -->|last task closes story| E[Story closed]
  E -->|last story closes epic| F[Epic closed]
```

## Gate lifecycle

```mermaid
flowchart LR
  A[Running] -->|block with gateType| B[Blocked / gate open]
  B -->|resume by operator| C[Ready]
  B -->|resume by wrong actor| B
  B -->|second resume| X[not_resumable]
```

Claim leases, attempt caps, and the checkpoint/evidence validation rules.

- **Claim**: atomic CAS under a lease. Highest-priority ready task selected when no id given.
- **Dependencies**: forward-only, cycle-checked. Cancelled deps count as resolved.
- **Gates**: block/resume with gate types. One resume per gate. Actor-checked.
- **Close**: closing the last task closes its story; closing the last story closes the epic and wakes the planner.
- **Starvation**: lives in the watcher manifest (deferred list, per-task idleMs).
- **Lease sweeper**: claims self-heal on next tick when the lease expires without heartbeats.
