CREATE TABLE `admission_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`item_id` text NOT NULL,
	`harness` text NOT NULL,
	`agent_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`event_id` integer,
	`executor_id` text,
	`offers` integer DEFAULT 0 NOT NULL,
	`backoff_until` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`offered_at` integer,
	`accepted_at` integer,
	`admitted_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "admission_kind" CHECK("admission_queue"."kind" IN ('task', 'story', 'append', 'review', 'unblocked')),
	CONSTRAINT "admission_status" CHECK("admission_queue"."status" IN ('queued', 'offered', 'accepted', 'active', 'done', 'cancelled', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_admission_live` ON `admission_queue` (`item_id`,`harness`) WHERE "admission_queue"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_admission_harness` ON `admission_queue` (`status`,`harness`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_admission_global` ON `admission_queue` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_admission_item` ON `admission_queue` (`item_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_work_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`harness` text NOT NULL,
	`agent_id` text NOT NULL,
	`external_session_id` text NOT NULL,
	`session_key` text GENERATED ALWAYS AS ("harness" || ':' || "agent_id" || ':' || "external_session_id") VIRTUAL,
	`kind` text DEFAULT 'claim' NOT NULL,
	`parent_session_id` text,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_session_id`) REFERENCES `work_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "work_sessions_kind" CHECK("__new_work_sessions"."kind" IN ('claim', 'review', 'system', 'fanout'))
);
--> statement-breakpoint
INSERT INTO `__new_work_sessions`("id", "item_id", "harness", "agent_id", "external_session_id", "kind", "parent_session_id", "created_at", "ended_at", "deleted_at") SELECT "id", "item_id", "harness", "agent_id", "external_session_id", "kind", NULL, "created_at", "ended_at", "deleted_at" FROM `work_sessions`;--> statement-breakpoint
DROP TABLE `work_sessions`;--> statement-breakpoint
ALTER TABLE `__new_work_sessions` RENAME TO `work_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sessions_identity` ON `work_sessions` (`harness`,`agent_id`,`external_session_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_item` ON `work_sessions` (`item_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_parent` ON `work_sessions` (`parent_session_id`);--> statement-breakpoint
ALTER TABLE `item_state` ADD `current_child_key` text GENERATED ALWAYS AS (json_extract("state_json", '$.currentChildKey')) VIRTUAL;--> statement-breakpoint
ALTER TABLE `items` ADD `child_key` text;--> statement-breakpoint
ALTER TABLE `items` ADD `visit_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_items_child` ON `items` (`parent_id`,`child_key`,`visit_seq`) WHERE "items"."child_key" IS NOT NULL;