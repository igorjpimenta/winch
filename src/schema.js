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
} from "drizzle-orm/sqlite-core";

export const EPIC_STATUSES = ["idea", "planned", "in_progress", "done", "cancelled"];
export const STORY_STATUSES = ["backlog", "ready", "in_progress", "review", "done", "blocked", "cancelled"];
export const TASK_STATUSES = ["todo", "in_progress", "done", "blocked", "cancelled"];
export const EXECUTION_KINDS = ["pipeclaw", "subagent", "cli", "gate", "manual"];
export const ITEM_KINDS = ["epic", "story", "task"];

const inList = (values) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const epics = sqliteTable("epics", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  acceptance: text("acceptance"),
  status: text("status").notNull(),
  ownerTeam: text("owner_team"),
  priority: integer("priority").notNull().default(50),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  closedAt: integer("closed_at"),
}, (table) => [
  check("epics_status", sql`${table.status} IN (${inList(EPIC_STATUSES)})`),
]);

export const stories = sqliteTable("stories", {
  id: text("id").primaryKey(),
  epicId: text("epic_id").notNull().references(() => epics.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  acceptance: text("acceptance"),
  status: text("status").notNull(),
  size: text("size"),
  priority: integer("priority").notNull().default(50),
  assigned: text("assigned"),
  capabilities: text("capabilities"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  closedAt: integer("closed_at"),
}, (table) => [
  check("stories_status", sql`${table.status} IN (${inList(STORY_STATUSES)})`),
  index("idx_stories_epic").on(table.epicId),
  index("idx_stories_status_assigned").on(table.status, table.assigned),
]);

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  storyId: text("story_id").notNull().references(() => stories.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull(),
  executionKind: text("execution_kind").notNull(),
  executionArgs: text("execution_args").notNull().default("{}"),
  assigned: text("assigned"),
  capabilities: text("capabilities"),
  flowId: text("flow_id"),
  taskRunId: text("task_run_id"),
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
}, (table) => [
  check("tasks_status", sql`${table.status} IN (${inList(TASK_STATUSES)})`),
  check("tasks_execution_kind", sql`${table.executionKind} IN (${inList(EXECUTION_KINDS)})`),
  index("idx_tasks_story").on(table.storyId),
  index("idx_tasks_status_assigned").on(table.status, table.assigned),
]);

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: text("task_id").notNull(),
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

export const deps = sqliteTable("deps", {
  fromId: text("from_id").notNull(),
  fromKind: text("from_kind").notNull(),
  toId: text("to_id").notNull(),
  toKind: text("to_kind").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.fromId, table.toId] }),
  check("deps_from_kind", sql`${table.fromKind} IN (${inList(ITEM_KINDS)})`),
  check("deps_to_kind", sql`${table.toKind} IN (${inList(ITEM_KINDS)})`),
  index("idx_deps_from").on(table.fromId),
  index("idx_deps_to").on(table.toId),
]);

