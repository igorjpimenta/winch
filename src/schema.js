// schema.js — the v8 schema: one recursive item tree with lifecycle,
// attempts, sessions, artifacts and an append-only ledger.
//
// Drizzle owns the table/column types, constraints, indexes, generated
// columns and relations; drizzle-kit generates the SQL in .migrations/ from
// this file. store.js queries these tables directly.
//
// The tree is `parent_id`: a task can split into subtasks without a schema
// change. `id` is opaque — nothing may parse it; `kind` is the discriminator.

import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  check,
  primaryKey,
} from "drizzle-orm/sqlite-core";

export const EPIC_STATUSES = ["idea", "planned", "in_progress", "done", "cancelled"];
export const STORY_STATUSES = ["backlog", "ready", "in_progress", "review", "done", "blocked", "cancelled"];
export const TASK_STATUSES = ["todo", "in_progress", "done", "blocked", "cancelled"];
export const ALL_STATUSES = [...new Set([...EPIC_STATUSES, ...STORY_STATUSES, ...TASK_STATUSES])];
export const EXECUTION_KINDS = ["pipeclaw", "subagent", "cli", "gate", "manual"];
export const ITEM_KINDS = ["epic", "story", "task"];
export const ATTEMPT_STATUSES = ["claimed", "running", "gated", "done", "failed", "released", "cancelled"];
export const SESSION_KINDS = ["claim", "review", "system"];
export const EDGE_KINDS = ["depends_on"];

const inList = (values) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const items = sqliteTable("items", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  parentId: text("parent_id").references(() => items.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  acceptance: text("acceptance"),
  priority: integer("priority").notNull().default(50),
  size: text("size"),
  ownerTeam: text("owner_team"),
  // Agent that planned the ticket; the dispatcher wakes it for the review.
  createdBy: text("created_by"),
  executionKind: text("execution_kind").notNull().default("manual"),
  executionArgs: text("execution_args").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  check("items_kind", sql`${table.kind} IN (${inList(ITEM_KINDS)})`),
  check("items_execution_kind", sql`${table.executionKind} IN (${inList(EXECUTION_KINDS)})`),
  check("items_root", sql`(${table.kind} = 'epic' AND ${table.parentId} IS NULL) OR (${table.kind} <> 'epic' AND ${table.parentId} IS NOT NULL)`),
  index("idx_items_parent").on(table.parentId),
  index("idx_items_kind_created").on(table.kind, table.createdAt),
]);

export const itemState = sqliteTable("item_state", {
  itemId: text("item_id").primaryKey().references(() => items.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull().default(0),
  status: text("status").notNull(),
  stateJson: text("state_json").notNull().default("{}"),
  waitKind: text("wait_kind").generatedAlwaysAs(sql`json_extract(${sql.identifier("state_json")}, '$.wait.kind')`, { mode: "virtual" }),
  assigneeHarness: text("assignee_harness"),
  assigneeAgent: text("assignee_agent"),
  updatedAt: integer("updated_at").notNull(),
  closedAt: integer("closed_at"),
  deletedAt: integer("deleted_at"),
}, (table) => [
  check("item_state_status", sql`${table.status} IN (${inList(ALL_STATUSES)})`),
  check("item_state_assignment_pair", sql`(${table.assigneeHarness} IS NULL) = (${table.assigneeAgent} IS NULL)`),
  index("idx_state_ready").on(table.status, table.assigneeHarness, table.assigneeAgent),
  index("idx_state_updated").on(table.updatedAt),
  index("idx_state_deleted").on(table.deletedAt),
]);

export const itemTags = sqliteTable("item_tags", {
  itemId: text("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  tag: text("tag").notNull(),
  source: text("source"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.itemId, table.tag] }),
  index("idx_tags_tag").on(table.tag),
]);

export const workSessions = sqliteTable("work_sessions", {
  id: text("id").primaryKey(),
  itemId: text("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  harness: text("harness").notNull(),
  agentId: text("agent_id").notNull(),
  externalSessionId: text("external_session_id").notNull(),
  sessionKey: text("session_key").generatedAlwaysAs(
    sql`${sql.identifier("harness")} || ':' || ${sql.identifier("agent_id")} || ':' || ${sql.identifier("external_session_id")}`,
    { mode: "virtual" },
  ),
  kind: text("kind").notNull().default("claim"),
  createdAt: integer("created_at").notNull(),
  endedAt: integer("ended_at"),
  deletedAt: integer("deleted_at"),
}, (table) => [
  check("work_sessions_kind", sql`${table.kind} IN (${inList(SESSION_KINDS)})`),
  uniqueIndex("uq_sessions_identity").on(table.harness, table.agentId, table.externalSessionId),
  index("idx_sessions_item").on(table.itemId),
]);

export const attempts = sqliteTable("attempts", {
  id: text("id").primaryKey(),
  itemId: text("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  attemptNo: integer("attempt_no").notNull(),
  sessionId: text("session_id").notNull().references(() => workSessions.id, { onDelete: "restrict" }),
  status: text("status").notNull(),
  claimedAt: integer("claimed_at").notNull(),
  heartbeatAt: integer("heartbeat_at"),
  leaseSeconds: integer("lease_seconds").notNull(),
  expiresAt: integer("expires_at").generatedAlwaysAs(
    sql`COALESCE(${sql.identifier("heartbeat_at")}, ${sql.identifier("claimed_at")}) + ${sql.identifier("lease_seconds")} * 1000`,
    { mode: "virtual" },
  ),
  endedAt: integer("ended_at"),
  resultJson: text("result_json"),
  resultSummary: text("result_summary").generatedAlwaysAs(sql`json_extract(${sql.identifier("result_json")}, '$.summary')`, { mode: "virtual" }),
  errorType: text("error_type"),
  gateRecordJson: text("gate_record_json"),
  gateType: text("gate_type").generatedAlwaysAs(sql`json_extract(${sql.identifier("gate_record_json")}, '$.type')`, { mode: "virtual" }),
}, (table) => [
  check("attempts_status", sql`${table.status} IN (${inList(ATTEMPT_STATUSES)})`),
  uniqueIndex("uq_attempt_item_no").on(table.itemId, table.attemptNo),
  index("idx_attempt_session").on(table.sessionId),
  uniqueIndex("uq_attempt_live").on(table.itemId).where(sql`${table.endedAt} IS NULL`),
  index("idx_attempts_expiry").on(table.status, table.expiresAt),
]);

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  itemId: text("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  attemptId: text("attempt_id").references(() => attempts.id, { onDelete: "set null" }),
  kind: text("kind").notNull(),
  uri: text("uri").notNull(),
  sha256: text("sha256"),
  label: text("label"),
  createdAt: integer("created_at").notNull(),
  deletedAt: integer("deleted_at"),
}, (table) => [
  uniqueIndex("uq_artifacts_uri").on(table.uri),
  index("idx_artifacts_item").on(table.itemId),
  index("idx_artifacts_attempt").on(table.attemptId),
]);

export const itemEvents = sqliteTable("item_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  itemId: text("item_id").notNull().references(() => items.id, { onDelete: "restrict" }),
  attemptId: text("attempt_id").references(() => attempts.id, { onDelete: "set null" }),
  sessionId: text("session_id").references(() => workSessions.id, { onDelete: "set null" }),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  kind: text("kind"),
  actor: text("actor"),
  note: text("note"),
  payloadJson: text("payload_json"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("idx_item_events_item").on(table.itemId),
  index("idx_item_events_created").on(table.createdAt),
]);

export const itemEdges = sqliteTable("item_edges", {
  fromItemId: text("from_item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  toItemId: text("to_item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("depends_on"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.fromItemId, table.toItemId, table.kind] }),
  check("item_edges_kind", sql`${table.kind} IN (${inList(EDGE_KINDS)})`),
  index("idx_edges_from").on(table.fromItemId),
  index("idx_edges_to").on(table.toItemId),
]);

export const harnessWebhooks = sqliteTable("harness_webhooks", {
  harness: text("harness").primaryKey(),
  url: text("url").notNull(),
  bearer: text("bearer"),
  timeoutMs: integer("timeout_ms"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
