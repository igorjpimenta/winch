// definitions.js — the MCP tool surface: names, descriptions, JSON schemas.
// Behaviour lives one file per family; this file is the contract a harness reads.

export const TOOL_DEFS = [
    {
      name: "backlog_claim",
      description:
        "Atomically claim work for THIS agent (identity resolved from request meta / environment). With `taskId`, claims that one task: " +
        "it must be ready AND currently claimable (deps done, caps intersect) — otherwise refused as not_claimed / not_ready, never queued. " +
        "Without `taskId`, claims the highest-priority ready task for this agent and silently tries the next candidate on a race. " +
        "Same CAS semantics under a per-identity lease either way; a targeted race gives back `raced`, never a partial claim.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string", description: "Task item id (opaque). Omit to claim the highest-priority ready task." },
          capabilities: {
            type: "array",
            items: { type: "string" },
            description: "Capability tags this agent offers; filters tasks whose required caps intersect.",
          },
          dryRun: {
            type: "boolean",
            description: "Report the task (or the next candidate) without claiming it.",
          },
        },
      },
    },
    {
      name: "backlog_assign",
      description:
        "Set (or clear) the assignee of a task or a story; that row is what wakes the assignee. " +
        "Assigning moves a backlog item to ready; clearing it returns the item to backlog. " +
        "A task assignee claims and delivers it. A story assignee breaks it down first: it reads the story and appends the tasks with " +
        "`backlog_append`, unassigned, so the planner can route them — use story assignment when the breakdown is not known at plan time. " +
        "Refuses to reassign a task already in progress by someone else. Passing `agent: null` or \"\" clears it. " +
        "The reserved agent `human` assigns human work with the reserved harness `human_in_the_loop`. " +
        "Optional `capabilities` replaces the item's capability tags.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "Item id (opaque) for a task or a story." },
          taskId: { type: "string", description: "Deprecated alias for `id` when assigning a task." },
          agent: { type: ["string", "null"], description: "Target agent id, or null/\"\" to unassign." },
          capabilities: {
            type: "array",
            items: { type: "string" },
            description: "Capability tags the item requires; replaces existing tags.",
          },
        },
      },
    },
    {
      name: "backlog_delegate",
      description:
        "Hand part of a task to another worker without changing the parent's accountable assignee. Creates a child task under the parent, " +
        "assigns it to `agent`, adds it to the parent's dependency wait, and parks the parent in `blocked`. Additional children may be " +
        "delegated while the parent is dependency-blocked; it returns to `ready` when every child closes. Use `agent: \"human\"` for " +
        "human work; the child carries the reserved human pair.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["taskId", "agent", "title"],
        properties: {
          taskId: { type: "string", description: "Parent task item id (opaque). The caller must be its accountable assignee or it must be unassigned." },
          agent: { type: "string", description: "Worker agent that claims and delivers the child. Use `human` for human work." },
          title: { type: "string", description: "Child task title." },
          childKey: { type: "string", description: "Stable fan-out lane name, e.g. docs. Same parent + key + visitSeq returns the existing child." },
          visitSeq: { type: "integer", minimum: 0, description: "Fan-out round for this childKey; default 0. A review re-run uses 1." },
          description: { type: "string", description: "Child task description." },
          acceptance: { type: "string", description: "What done means for the child. Defaults to the parent acceptance." },
          capabilities: {
            type: "array",
            items: { type: "string" },
            description: "Capability tags the child requires. Defaults to the parent tags.",
          },
          executionKind: {
            type: "string",
            enum: ["pipeclaw", "subagent", "cli", "gate", "manual"],
            description: "How the child is executed; default manual.",
          },
          executionArgs: { type: "object", description: "Execution arguments for the child." },
          reason: { type: "string", description: "Why the work is delegated; recorded on the parent wait." },
        },
      },
    },
    {
      name: "backlog_plan",
      description:
        "Create a whole plan in one call: an epic, its stories, and their tasks, wired with dependencies. This is how a planner " +
        "protocols a demand — the spec goes INTO the records (task description, story acceptance, capability tags), because a " +
        "worker receives only a task id and reads the record itself. Tasks land `backlog`; assigning one moves it to `ready`. Use " +
        "`backlog_assign`. `dependsOn` references other tasks in the same plan by key (default `s<story>t<task>`, zero-based) " +
        "and may only point backward, so the plan is acyclic by construction. All-or-nothing: an invalid key rolls back the plan.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["epic", "stories"],
        properties: {
          epic: {
            type: "object",
            description: "The epic this plan creates.",
            additionalProperties: false,
            required: ["title"],
            properties: {
              title: { type: "string" },
              description: { type: "string", description: "Why this epic exists and any shared constraint." },
              acceptance: { type: "string", description: "What done means for the epic." },
              priority: { type: "integer", description: "0-100, default 50." },
            },
          },
          stories: {
            type: "array",
            minItems: 1,
            description: "Stories to create under the epic, each with its tasks.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "tasks"],
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                acceptance: { type: "string", description: "Verifiable acceptance criteria; every worker on this story sees it." },
                priority: { type: "integer" },
                capabilities: { type: "array", items: { type: "string" }, description: "Default capability tags for the story's tasks." },
                tasks: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["title"],
                    properties: {
                      title: { type: "string" },
                      description: { type: "string", description: "Everything the worker needs: what to build, where, and the constraints. There is no other brief." },
                      key: { type: "string", description: "Referenced by dependsOn; defaults to s<story>t<task> (zero-based)." },
                      executionKind: { type: "string", enum: ["pipeclaw", "subagent", "cli", "gate", "manual"] },
                      executionArgs: { type: "object", description: "Structured args the worker's harness understands." },
                      capabilities: { type: "array", items: { type: "string" }, description: "Capability tags the work truly needs." },
                      dependsOn: { type: "array", items: { type: "string" }, description: "Keys of earlier tasks in this plan that must finish first." },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    {
      name: "backlog_append",
      description:
        "Append to an existing plan: add stories to an epic, and/or tasks to a story, after work has started. Use it for a gap a worker " +
        "found, a follow-up from review, or a story split discovered late. Both kinds are written with the same self-sufficient record a " +
        "planned item carries; tasks land `backlog` unless `assigned` is given (then `ready`), and a `task.appended` row is written so a dispatcher can " +
        "route them. `dependsOn` accepts a key from this call or an existing item id. All-or-nothing.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          epicId: { type: "string", description: "Epic item id (opaque)." },
          storyId: { type: "string", description: "Story item id (opaque)." },
          stories: {
            type: "array",
            description: "Stories to append to epicId.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "tasks"],
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                acceptance: { type: "string", description: "Verifiable criteria; every worker on the story reads them." },
                priority: { type: "integer" },
                capabilities: { type: "array", items: { type: "string" } },
                tasks: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["title"],
                    properties: {
                      title: { type: "string" },
                      description: { type: "string" },
                      key: { type: "string", description: "Referenced by dependsOn within this call; defaults to s<story>t<task>." },
                      executionKind: { type: "string", enum: ["pipeclaw", "subagent", "cli", "gate", "manual"] },
                      executionArgs: { type: "object" },
                      capabilities: { type: "array", items: { type: "string" } },
                      assigned: { type: "string", description: "Leave empty so the planner routes it." },
                      dependsOn: { type: "array", items: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
          tasks: {
            type: "array",
            description: "Tasks to append to storyId.",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title"],
              properties: {
                title: { type: "string" },
                description: { type: "string", description: "What to build, where, how to verify, what is out of scope." },
                key: { type: "string", description: "Referenced by dependsOn within this call; defaults to a<index>." },
                executionKind: { type: "string", enum: ["pipeclaw", "subagent", "cli", "gate", "manual"] },
                executionArgs: { type: "object" },
                capabilities: { type: "array", items: { type: "string" } },
                assigned: { type: "string", description: "Leave empty so the planner routes it." },
                dependsOn: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
    {
      name: "backlog_drop",
      description:
        "Disable an epic, story or task that was never claimed — a plan correction, a duplicate, or a story that no longer applies. " +
        "Nothing is deleted: the item and everything under it move to `cancelled`, dependencies are left in place (a cancelled dependency " +
        "counts as resolved), and each task leaves a `task.dropped` row. Refused if anything under it has been claimed (claimed_at set, " +
        "or any status other than backlog/ready): closing real work is `backlog_done`'s job. `backlog_restore` undoes this.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string", description: "Item id (opaque): epic, story or task." },
          reason: { type: "string", description: "Why it is being dropped; recorded on each audit row." },
        },
      },
    },
    {
      name: "backlog_report_usage",
      description:
        "Record an LLM usage/cost event attributed to the caller (harness/agent/session), " +
        "optionally linked to an item. Optional feature: only records when costTracking is enabled. " +
        "Use to attribute per-call token/cost data to work.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          itemId: { type: "string", description: "Optional EPIC-.../STORY-.../TASK-... (or any item id) to attribute this usage to." },
          item_id: { type: "string", description: "Alias for itemId." },
          itemKind: { type: "string", description: "Kind of itemId: epic|story|task (inferred from prefix if omitted)." },
          item_kind: { type: "string", description: "Alias for itemKind." },
          taskId: { type: "string", description: "Optional TASK-... to attribute this usage to (alias for itemId with kind task)." },
          task_id: { type: "string", description: "Alias for taskId." },
          model: { type: "string", description: "Model name." },
          tokensIn: { type: "integer", description: "Input tokens." },
          tokens_in: { type: "integer", description: "Alias for tokensIn." },
          tokensOut: { type: "integer", description: "Output tokens." },
          tokens_out: { type: "integer", description: "Alias for tokensOut." },
          cacheRead: { type: "integer", description: "Cached input tokens." },
          cache_read: { type: "integer", description: "Alias for cacheRead." },
          costUsd: { type: "number", description: "Cost in USD." },
          cost_usd: { type: "number", description: "Alias for costUsd." },
          cost: { type: "number", description: "Alias for costUsd." },
          toolCalls: { type: "integer", description: "Tool calls in this turn." },
          tool_calls: { type: "integer", description: "Alias for toolCalls." },
        },
      },
    },
    {
      name: "backlog_restore",
      description:
        "Undo `backlog_drop`: return a dropped epic, story or task, and everything dropped with it, to the queue (epic ready, " +
        "story ready, task ready), writing a `task.restored` row for each. Dependencies were never removed, so ordering comes back intact.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: { type: "string", description: "Item id (opaque): epic, story or task." } },
      },
    },
    {
      name: "backlog_get",
      description:
        "Read the backlog at any level with one call: pass an epic item id for the whole tree (stories, acceptance, every task, results, " +
        "artifacts, counts), a story item id for the story with its tasks and parent epic, or a task item id for the task with its story " +
        "acceptance, epic, artifacts, dependencies and readiness. Read-only; never claims.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string", description: "Item id (opaque): epic, story or task." },
          capabilities: {
            type: "array",
            items: { type: "string" },
            description: "For a task read: capability tags this agent offers, used only to report readiness.",
          },
        },
      },
    },
    {
      name: "backlog_accept_wake",
      description:
        "Acquire the execution lease for a story/append/review wake. Call this once before doing planner work. " +
        "The dispatcher marks one consumer active; this CAS makes it the only session allowed to act.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["admissionId", "attemptNo", "leaseEpoch"],
        properties: {
          admissionId: { type: "string", description: "Admission id from the wake payload." },
          attemptNo: { type: "integer", description: "Attempt number from the wake payload." },
          leaseEpoch: { type: "integer", description: "Lease epoch from the wake payload; stale epochs are rejected." },
        },
      },
    },
    {
      name: "backlog_update",
      description:
        "Report liveness and progress on a task you have claimed. `heartbeat: true` refreshes last_heartbeat " +
        "(the sweeper reclaims tasks whose lease expires without heartbeats). `progressSummary`/`comment` append " +
        "an audit event. Only the assigned agent may update.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["taskId"],
        properties: {
          taskId: { type: "string", description: "Task item id (opaque)." },
          attemptId: { type: "string", description: "Attempt id from recovery or claim; fences a stale session out of a newer attempt." },
          leaseEpoch: { type: "integer", description: "Execution lease epoch from claim or recovery; required for wake-owned attempts." },
          heartbeat: { type: "boolean", description: "Refresh liveness (default true)." },
          progressSummary: { type: "string", description: "One-line progress note for the audit trail." },
          comment: { type: "string", description: "Freeform note appended as an audit event." },
          addArtifact: { type: "string", description: "Artifact path/URL produced so far; recorded as an audit event and carried into downstream handoffs." },
        },
      },
    },
    {
      name: "backlog_done",
      description:
        "Close a task you have claimed: status → done, result summary recorded, audit event appended. " +
        "Only the assigned agent may complete it. The next dependent task becomes claimable.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["taskId", "resultSummary"],
        properties: {
          taskId: { type: "string", description: "Task item id (opaque)." },
          attemptId: { type: "string", description: "Attempt id from recovery or claim; fences a stale session out of a newer attempt." },
          leaseEpoch: { type: "integer", description: "Execution lease epoch from claim or recovery; required for wake-owned attempts." },
          resultSummary: { type: "string", description: "One-paragraph outcome (success or failure)." },
          artifacts: { type: "array", items: { type: "string" }, description: "Paths/URLs of produced artifacts (diff, doc, PR)." },
        },
      },
    },
    {
      name: "backlog_block",
      description:
        "Mark a task you have claimed as blocked with a reason; optionally declare what it is blocked by " +
        "(`blockedBy: {kind, id}`) which adds a dependency edge (cycle-checked). Blocked tasks leave the " +
        "ready queue until an operator unblocks them. Only the assigned agent may block.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["taskId", "reason"],
        properties: {
          taskId: { type: "string", description: "Task item id (opaque)." },
          attemptId: { type: "string", description: "Attempt id from recovery or claim; fences a stale session out of a newer attempt." },
          leaseEpoch: { type: "integer", description: "Execution lease epoch from claim or recovery; required for wake-owned attempts." },
          reason: { type: "string", description: "Why the task cannot proceed." },
          gateType: { type: "string", description: "Human gate being opened (roadmap|architecture|release|custom) — stamps gate_type; resume clears it." },
          blockedBy: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "id"],
            properties: {
              kind: { type: "string", enum: ["epic", "story", "task"] },
              id: { type: "string" },
            },
            description: "Item this task now depends on (edge added, cycle-checked).",
          },
        },
      },
    },
    {
      name: "backlog_resume",
      description:
        "Operator resolution of a human gate: blocked → ready with claim fields and gate metadata cleared, " +
        "so the task re-enters the queue for a fresh claim. One resume per gate — a second call is rejected " +
        "as not_resumable.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["taskId"],
        properties: {
          taskId: { type: "string", description: "Task item id (opaque)." },
          actor: { type: "string", description: "Must equal the caller's agent when given; anyone else's name is rejected as actor_mismatch. Defaults to the caller." },
        },
      },
    },
];
