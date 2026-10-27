// definitions.js — the MCP tool surface: names, descriptions, JSON schemas.
// Behaviour lives one file per family; this file is the contract a harness reads.

export const TOOL_DEFS = [
    {
      name: "backlog_claim",
      description:
        "Atomically claim work for THIS agent (identity resolved from request meta / environment). With `taskId`, claims that one task: " +
        "it must be todo AND currently ready (deps done, caps intersect) — otherwise refused as not_claimed / not_ready, never queued. " +
        "Without `taskId`, claims the highest-priority ready task for this agent and silently tries the next candidate on a race. " +
        "Same CAS semantics under a per-identity lease either way; a targeted race gives back `raced`, never a partial claim.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string", description: "Task id (TASK-…). Omit to claim the highest-priority ready task." },
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
        "A task assignee claims and delivers it. A story assignee breaks it down first: it reads the story and appends the tasks with " +
        "`backlog_append`, unassigned, so the planner can route them — use story assignment when the breakdown is not known at plan time. " +
        "Refuses to reassign a task already in progress by someone else. Passing `agent: null` or \"\" clears it. " +
        "Optional `capabilities` replaces the item's capability tags.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "TASK-… or STORY-…." },
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
      name: "backlog_plan",
      description:
        "Create a whole plan in one call: an epic, its stories, and their tasks, wired with dependencies. This is how a planner " +
        "protocols a demand — the spec goes INTO the records (task description, story acceptance, capability tags), because a " +
        "worker receives only a task id and reads the record itself. Tasks are created `todo` and unassigned; assign them with " +
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
        "planned item carries; tasks land `todo` unless `assigned` is given, and a `task.appended` row is written so a dispatcher can " +
        "route them. `dependsOn` accepts a key from this call or an existing TASK-/STORY-/EPIC- id. All-or-nothing.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          epicId: { type: "string", description: "Epic to add stories to (EPIC-…)." },
          storyId: { type: "string", description: "Story to add tasks to (STORY-…)." },
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
        "or any status other than todo): closing real work is `backlog_done`'s job. `backlog_restore` undoes this.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string", description: "EPIC-…, STORY-… or TASK-…." },
          reason: { type: "string", description: "Why it is being dropped; recorded on each audit row." },
        },
      },
    },
    {
      name: "backlog_restore",
      description:
        "Undo `backlog_drop`: return a dropped epic, story or task, and everything dropped with it, to the queue (epic planned, " +
        "story ready, task todo), writing a `task.restored` row for each. Dependencies were never removed, so ordering comes back intact.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: { type: "string", description: "EPIC-…, STORY-… or TASK-…." } },
      },
    },
    {
      name: "backlog_get",
      description:
        "Read the backlog at any level with one call: pass an EPIC-… id for the whole tree (stories, acceptance, every task, results, " +
        "artifacts, counts), a STORY-… id for the story with its tasks and parent epic, or a TASK-… id for the task with its story " +
        "acceptance, epic, artifacts, dependencies and readiness. Read-only; never claims.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string", description: "EPIC-…, STORY-… or TASK-…." },
          capabilities: {
            type: "array",
            items: { type: "string" },
            description: "For a task read: capability tags this agent offers, used only to report readiness.",
          },
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
          taskId: { type: "string", description: "Task id (TASK-…)." },
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
          taskId: { type: "string", description: "Task id (TASK-…)." },
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
          taskId: { type: "string", description: "Task id (TASK-…)." },
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
        "Operator resolution of a human gate: blocked → todo with claim fields and gate metadata cleared, " +
        "so the task re-enters the queue for a fresh claim. One resume per gate — a second call is rejected " +
        "as not_resumable.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["taskId"],
        properties: {
          taskId: { type: "string", description: "Task id (TASK-…)." },
          actor: { type: "string", description: "Must equal the caller's agent when given; anyone else's name is rejected as actor_mismatch. Defaults to the caller." },
        },
      },
    },
];
