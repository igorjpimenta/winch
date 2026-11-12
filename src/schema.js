// schema.js — the application schema. Drizzle owns the table/column types,
// constraints, indexes, and relations; drizzle-kit generates the migration
// SQL in .migrations/ from this file. store.js queries these tables directly.

import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  index,
  check,
  primaryKey,
  real,
} from "drizzle-orm/sqlite-core";

export const USAGE_SOURCES = ["meta", "tool", "cli", "plugin"];

export const ITEM_KINDS = ["epic", "story", "task"];
export const ITEM_STATUSES = ["idea", "planned", "backlog", "ready", "todo", "in_progress", "review", "done", "blocked", "cancelled"];
export const EPIC_STATUSES = ITEM_STATUSES;
export const STORY_STATUSES = ITEM_STATUSES;
export const TASK_STATUSES = ITEM_STATUSES;
export const EXECUTION_KINDS = ["pipeclaw", "subagent", "cli", "gate", "manual"];

const inList = (values) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const items = sqliteTable("items", {
  id: text("id").primaryKey(),
  // Unified hierarchy: parent_id replaces epic_id/story_id. Root items (epics)
  // have NULL. Arbitrary depth is allowed (epic -> story -> task -> subtask).
  parentId: text("parent_id"),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  acceptance: text("acceptance"),
  status: text("status").notNull(),
  size: text("size"),
  priority: integer("priority").notNull().default(50),
  ownerTeam: text("owner_team"),
  createdBy: text("created_by"),
  assigned: text("assigned"),
  capabilities: text("capabilities"),
  executionKind: text("execution_kind"),
  executionArgs: text("execution_args").notNull().default("{}"),
  claimExpiresAt: integer("claim_expires_at"),
  leaseSeconds: integer("lease_seconds"),
  lastHeartbeat: integer("last_heartbeat"),
  attemptCount: integer("attempt_count").notNull().default(0),
  gateType: text("gate_type"),
  blockedAt: integer("blocked_at"),
  resultSummary: text("result_summary"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  claimedAt: integer("claimed_at"),
  closedAt: integer("closed_at"),
  deletedAt: integer("deleted_at"),
}, (table) => [
  check("items_kind", sql`${table.kind} IN (${inList(ITEM_KINDS)})`),
  check("items_status", sql`${table.status} IN (${inList(ITEM_STATUSES)})`),
  index("idx_items_parent").on(table.parentId),
  index("idx_items_kind_status_assigned").on(table.kind, table.status, table.assigned),
]);

// Note: no aliases exported. Consumers use `items` (or store wrappers).

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Item-scoped audit log: item_id carries the id of the item the row is
  // about (epic/story/task); item_kind says which kind.
  itemId: text("item_id").notNull(),
  itemKind: text("item_kind").notNull().default("task"),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  // Declared by the producer at write time (openGate stamps gate.opened,
  // resumeGate gate.resolved, claim task.claimed, …). NULL means pre-kind
  // row: the wire infers via the legacy rules, which exist only as backfill.
  kind: text("kind"),
  actor: text("actor"),
  note: text("note"),
  sessionRef: text("session_ref"),
  at: integer("at").notNull(),
}, (table) => [
  index("idx_events_task").on(table.taskId),
]);

export const webhookTargets = sqliteTable("webhook_targets", {
  // One callback URL per harness, registered via `winch webhook set`.
  // Checked first at claim time, before the env-mapped and single-URL
  // config: a CLI registration is a deliberate admin act on the live system.
  harness: text("harness").primaryKey(),
  url: text("url").notNull(),
  bearer: text("bearer"),
  timeoutMs: integer("timeout_ms"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const usageEvents = sqliteTable("usage_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  harness: text("harness").notNull(),
  agent: text("agent").notNull(),
  session: text("session").notNull(),
  // Generalized attribution: any backlog item (epic/story/task) or plan can
  // own a usage event — not just tasks, since all work consumes tokens.
  itemId: text("item_id"),
  // item_kind dropped: derivable via items.kind join. Kept nullable for
  // backward compat with older rows; new rows may leave it null.
  itemKind: text("item_kind"),
  model: text("model"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  cacheRead: integer("cache_read"),
  costUsd: real("cost_usd"),
  toolCalls: integer("tool_calls"),
  source: text("source"),
  at: integer("at").notNull(),
}, (table) => [
  index("idx_usage_events_identity").on(table.harness, table.agent, table.session),
  index("idx_usage_events_task").on(table.itemId),
  index("idx_usage_events_at").on(table.at),
]);

export const sessionBindings = sqliteTable("session_bindings", {
  sessionKey: text("session_key").primaryKey(),
  itemId: text("item_id").notNull(),
  itemKind: text("item_kind").notNull(),
  boundAt: integer("bound_at").notNull(),
  releasedAt: integer("released_at"),
});

export const deps = sqliteTable("deps", {
  fromItemId: text("from_item_id").notNull(),
  fromKind: text("from_kind").notNull(),
  toItemId: text("to_item_id").notNull(),
  toKind: text("to_kind").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.fromItemId, table.toItemId] }),
  check("deps_from_kind", sql`${table.fromKind} IN (${inList(ITEM_KINDS)})`),
  check("deps_to_kind", sql`${table.toKind} IN (${inList(ITEM_KINDS)})`),
  index("idx_deps_from").on(table.fromItemId),
  index("idx_deps_to").on(table.toItemId),
]);

