-- One recursive item tree, lifecycle split out, attempts/sessions as
-- first-class rows, and a single append-only ledger. Data is copied from the
-- legacy tables before they are dropped, so the migration is in-place.
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`parent_id` text,
	`title` text NOT NULL,
	`description` text,
	`acceptance` text,
	`priority` integer DEFAULT 50 NOT NULL,
	`size` text,
	`owner_team` text,
	`created_by` text,
	`execution_kind` text DEFAULT 'manual' NOT NULL,
	`execution_args` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "items_kind" CHECK("items"."kind" IN ('epic', 'story', 'task')),
	CONSTRAINT "items_execution_kind" CHECK("items"."execution_kind" IN ('pipeclaw', 'subagent', 'cli', 'gate', 'manual')),
	CONSTRAINT "items_root" CHECK(("items"."kind" = 'epic' AND "items"."parent_id" IS NULL) OR ("items"."kind" <> 'epic' AND "items"."parent_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_items_parent` ON `items` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_items_kind_created` ON `items` (`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `item_state` (
	`item_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`state_json` text DEFAULT '{}' NOT NULL,
	`wait_kind` text GENERATED ALWAYS AS (json_extract("state_json", '$.wait.kind')) VIRTUAL,
	`assignee_harness` text,
	`assignee_agent` text,
	`updated_at` integer NOT NULL,
	`closed_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "item_state_status" CHECK("item_state"."status" IN ('idea', 'planned', 'in_progress', 'done', 'cancelled', 'backlog', 'ready', 'review', 'blocked', 'todo')),
	CONSTRAINT "item_state_assignment_pair" CHECK(("item_state"."assignee_harness" IS NULL) = ("item_state"."assignee_agent" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_state_ready` ON `item_state` (`status`,`assignee_harness`,`assignee_agent`);--> statement-breakpoint
CREATE INDEX `idx_state_updated` ON `item_state` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_state_deleted` ON `item_state` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `item_tags` (
	`item_id` text NOT NULL,
	`tag` text NOT NULL,
	`source` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`item_id`, `tag`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tags_tag` ON `item_tags` (`tag`);--> statement-breakpoint
CREATE TABLE `work_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`harness` text NOT NULL,
	`agent_id` text NOT NULL,
	`external_session_id` text NOT NULL,
	`session_key` text GENERATED ALWAYS AS ("harness" || ':' || "agent_id" || ':' || "external_session_id") VIRTUAL,
	`kind` text DEFAULT 'claim' NOT NULL,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "work_sessions_kind" CHECK("work_sessions"."kind" IN ('claim', 'review', 'system'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sessions_identity` ON `work_sessions` (`harness`,`agent_id`,`external_session_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_item` ON `work_sessions` (`item_id`);--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`session_id` text NOT NULL,
	`status` text NOT NULL,
	`claimed_at` integer NOT NULL,
	`heartbeat_at` integer,
	`lease_seconds` integer NOT NULL,
	`expires_at` integer GENERATED ALWAYS AS (COALESCE("heartbeat_at", "claimed_at") + "lease_seconds" * 1000) VIRTUAL,
	`ended_at` integer,
	`result_json` text,
	`result_summary` text GENERATED ALWAYS AS (json_extract("result_json", '$.summary')) VIRTUAL,
	`error_type` text,
	`gate_record_json` text,
	`gate_type` text GENERATED ALWAYS AS (json_extract("gate_record_json", '$.type')) VIRTUAL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `work_sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "attempts_status" CHECK("attempts"."status" IN ('claimed', 'running', 'gated', 'done', 'failed', 'released', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_attempt_item_no` ON `attempts` (`item_id`,`attempt_no`);--> statement-breakpoint
CREATE INDEX `idx_attempt_session` ON `attempts` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_attempt_live` ON `attempts` (`item_id`) WHERE "attempts"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_attempts_expiry` ON `attempts` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`attempt_id` text,
	`kind` text NOT NULL,
	`uri` text NOT NULL,
	`sha256` text,
	`label` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_artifacts_uri` ON `artifacts` (`uri`);--> statement-breakpoint
CREATE INDEX `idx_artifacts_item` ON `artifacts` (`item_id`);--> statement-breakpoint
CREATE INDEX `idx_artifacts_attempt` ON `artifacts` (`attempt_id`);--> statement-breakpoint
CREATE TABLE `item_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` text NOT NULL,
	`attempt_id` text,
	`session_id` text,
	`from_status` text,
	`to_status` text NOT NULL,
	`kind` text,
	`actor` text,
	`note` text,
	`payload_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `work_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_item_events_item` ON `item_events` (`item_id`);--> statement-breakpoint
CREATE INDEX `idx_item_events_created` ON `item_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `item_edges` (
	`from_item_id` text NOT NULL,
	`to_item_id` text NOT NULL,
	`kind` text DEFAULT 'depends_on' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`from_item_id`, `to_item_id`, `kind`),
	FOREIGN KEY (`from_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "item_edges_kind" CHECK("item_edges"."kind" IN ('depends_on'))
);
--> statement-breakpoint
CREATE INDEX `idx_edges_from` ON `item_edges` (`from_item_id`);--> statement-breakpoint
CREATE INDEX `idx_edges_to` ON `item_edges` (`to_item_id`);--> statement-breakpoint
CREATE TABLE `harness_webhooks` (
	`harness` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`bearer` text,
	`timeout_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
-- ── copy legacy rows into the recursive tree ─────────────────────────────
INSERT INTO items (id, kind, parent_id, title, description, acceptance,
                   priority, size, owner_team, created_by, execution_kind, execution_args, created_at)
SELECT id, 'epic', NULL, title, description, acceptance,
       priority, NULL, owner_team, created_by, 'manual', '{}', created_at
  FROM epics;
--> statement-breakpoint
INSERT INTO items (id, kind, parent_id, title, description, acceptance,
                   priority, size, owner_team, created_by, execution_kind, execution_args, created_at)
SELECT id, 'story', epic_id, title, description, acceptance,
       priority, size, NULL, NULL, 'manual', '{}', created_at
  FROM stories;
--> statement-breakpoint
INSERT INTO items (id, kind, parent_id, title, description, acceptance,
                   priority, size, owner_team, created_by, execution_kind, execution_args, created_at)
SELECT id, 'task', story_id, title, description, NULL,
       50, NULL, NULL, NULL, execution_kind, COALESCE(execution_args, '{}'), created_at
  FROM tasks;
--> statement-breakpoint
INSERT INTO item_state (item_id, revision, status, state_json, assignee_harness, assignee_agent, updated_at, closed_at)
SELECT id, 0, status, '{}', NULL, NULL, updated_at, closed_at FROM epics;
--> statement-breakpoint
INSERT INTO item_state (item_id, revision, status, state_json, assignee_harness, assignee_agent, updated_at, closed_at)
SELECT id, 0, status, '{}',
       CASE WHEN assigned IS NULL THEN NULL ELSE 'legacy' END,
       assigned, updated_at, closed_at
  FROM stories;
--> statement-breakpoint
INSERT INTO item_state (item_id, revision, status, state_json, assignee_harness, assignee_agent, updated_at, closed_at)
SELECT id, 0, status, '{}',
       CASE WHEN assigned IS NULL THEN NULL ELSE 'legacy' END,
       assigned, updated_at, closed_at
  FROM tasks;
--> statement-breakpoint
INSERT OR IGNORE INTO item_tags (item_id, tag, source, created_at)
SELECT s.id, j.value, 'legacy', s.created_at
  FROM stories s, json_each(s.capabilities) j
 WHERE s.capabilities IS NOT NULL AND json_valid(s.capabilities);
--> statement-breakpoint
INSERT OR IGNORE INTO item_tags (item_id, tag, source, created_at)
SELECT t.id, j.value, 'legacy', t.created_at
  FROM tasks t, json_each(t.capabilities) j
 WHERE t.capabilities IS NOT NULL AND json_valid(t.capabilities);
--> statement-breakpoint
INSERT INTO item_edges (from_item_id, to_item_id, kind, created_at)
SELECT d.from_id, d.to_id, 'depends_on', d.created_at
  FROM deps d
 WHERE EXISTS (SELECT 1 FROM items i WHERE i.id = d.from_id)
   AND EXISTS (SELECT 1 FROM items i WHERE i.id = d.to_id);
--> statement-breakpoint
INSERT INTO work_sessions (id, item_id, harness, agent_id, external_session_id, kind, created_at)
SELECT 'SES-legacy-' || id, id, 'legacy',
       COALESCE(assigned, 'system'), 'legacy-' || id, 'system', COALESCE(claimed_at, created_at)
  FROM tasks
 WHERE claimed_at IS NOT NULL OR attempt_count > 0
    OR status IN ('in_progress', 'blocked', 'done', 'cancelled');
--> statement-breakpoint
INSERT INTO attempts (id, item_id, attempt_no, session_id, status, claimed_at, heartbeat_at,
                      lease_seconds, ended_at, result_json, error_type, gate_record_json)
SELECT 'ATT-legacy-' || t.id, t.id, MAX(COALESCE(t.attempt_count, 1), 1),
       'SES-legacy-' || t.id,
       CASE
         WHEN t.status = 'in_progress' THEN 'running'
         WHEN t.status = 'blocked' AND t.gate_type IS NOT NULL THEN 'gated'
         WHEN t.status = 'done' THEN 'done'
         WHEN t.status = 'cancelled' THEN 'cancelled'
         ELSE 'released'
       END,
       COALESCE(t.claimed_at, t.created_at), t.last_heartbeat,
       COALESCE(t.lease_seconds, 1800),
       CASE WHEN t.status = 'in_progress' THEN NULL ELSE COALESCE(t.closed_at, t.updated_at, t.claimed_at) END,
       CASE WHEN t.result_summary IS NOT NULL THEN json_object('summary', t.result_summary) END,
       NULL,
       CASE WHEN t.gate_type IS NOT NULL
            THEN json_object('type', t.gate_type, 'openedAt', COALESCE(t.blocked_at, t.updated_at)) END
  FROM tasks t
 WHERE t.claimed_at IS NOT NULL OR t.attempt_count > 0
    OR t.status IN ('in_progress', 'blocked', 'done', 'cancelled');
--> statement-breakpoint
-- Event ids are preserved: the WebSocket cursor is an id, and a reopen must
-- not replay or skip history.
INSERT INTO item_events (id, item_id, attempt_id, session_id, from_status, to_status, kind, actor, note, payload_json, created_at)
SELECT e.id, e.task_id,
       (SELECT a.id FROM attempts a WHERE a.item_id = e.task_id LIMIT 1),
       (SELECT a.session_id FROM attempts a WHERE a.item_id = e.task_id LIMIT 1),
       e.from_status, e.to_status, e.kind, e.actor, e.note, NULL, e.at
  FROM events e
 WHERE EXISTS (SELECT 1 FROM items i WHERE i.id = e.task_id);
--> statement-breakpoint
INSERT OR IGNORE INTO artifacts (id, item_id, attempt_id, kind, uri, label, created_at)
SELECT 'ART-legacy-' || e.id, e.task_id,
       (SELECT a.id FROM attempts a WHERE a.item_id = e.task_id LIMIT 1),
       'link', trim(substr(e.note, 11)), 'legacy', e.at
  FROM events e
 WHERE e.note LIKE 'artifact: %'
   AND EXISTS (SELECT 1 FROM items i WHERE i.id = e.task_id);
--> statement-breakpoint
INSERT INTO harness_webhooks (harness, url, bearer, timeout_ms, created_at, updated_at)
SELECT harness, url, bearer, timeout_ms, created_at, updated_at FROM webhook_targets;
--> statement-breakpoint
DROP TABLE `webhook_targets`;
--> statement-breakpoint
DROP TABLE `deps`;
--> statement-breakpoint
DROP TABLE `events`;
--> statement-breakpoint
DROP TABLE `tasks`;
--> statement-breakpoint
DROP TABLE `stories`;
--> statement-breakpoint
DROP TABLE `epics`;
