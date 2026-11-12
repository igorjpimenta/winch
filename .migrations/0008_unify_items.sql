PRAGMA foreign_keys = OFF;--> statement-breakpoint
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('epic','story','task')),
  title TEXT NOT NULL,
  description TEXT,
  acceptance TEXT,
  status TEXT NOT NULL,
  size TEXT,
  priority INTEGER NOT NULL DEFAULT 50,
  owner_team TEXT,
  created_by TEXT,
  assigned TEXT,
  capabilities TEXT,
  execution_kind TEXT,
  execution_args TEXT NOT NULL DEFAULT '{}',
  claim_expires_at INTEGER,
  lease_seconds INTEGER,
  last_heartbeat INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  gate_type TEXT,
  blocked_at INTEGER,
  result_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  claimed_at INTEGER,
  closed_at INTEGER,
  deleted_at INTEGER
);--> statement-breakpoint
INSERT INTO items (id, parent_id, kind, title, description, acceptance, status, priority, owner_team, created_by, created_at, updated_at, closed_at)
SELECT id, NULL, 'epic', title, description, acceptance, status, priority, owner_team, created_by, created_at, updated_at, closed_at FROM epics;--> statement-breakpoint
INSERT INTO items (id, parent_id, kind, title, description, acceptance, status, size, priority, assigned, capabilities, created_at, updated_at, closed_at)
SELECT id, epic_id, 'story', title, description, acceptance, status, size, priority, assigned, capabilities, created_at, updated_at, closed_at FROM stories;--> statement-breakpoint
INSERT INTO items (id, parent_id, kind, title, description, status, priority, assigned, capabilities, execution_kind, execution_args, claim_expires_at, lease_seconds, last_heartbeat, attempt_count, gate_type, blocked_at, result_summary, created_at, updated_at, claimed_at, closed_at)
SELECT id, story_id, 'task', title, description, status, 50, assigned, capabilities, execution_kind, execution_args, claim_expires_at, lease_seconds, last_heartbeat, attempt_count, gate_type, blocked_at, result_summary, created_at, updated_at, claimed_at, closed_at FROM tasks;--> statement-breakpoint
ALTER TABLE events RENAME COLUMN task_id TO item_id;--> statement-breakpoint
ALTER TABLE deps RENAME COLUMN from_id TO from_item_id;--> statement-breakpoint
ALTER TABLE deps RENAME COLUMN to_id TO to_item_id;--> statement-breakpoint
DROP INDEX IF EXISTS idx_usage_events_task;--> statement-breakpoint
ALTER TABLE usage_events DROP COLUMN task_id;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_usage_events_task ON usage_events(item_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_items_kind_status_assigned ON items(kind, status, assigned);--> statement-breakpoint
DROP TABLE tasks;--> statement-breakpoint
DROP TABLE stories;--> statement-breakpoint
DROP TABLE epics;
