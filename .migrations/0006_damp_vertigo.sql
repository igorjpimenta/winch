CREATE TABLE `usage_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`harness` text NOT NULL,
	`agent` text NOT NULL,
	`session` text NOT NULL,
	`task_id` text,
	`item_id` text,
	`item_kind` text,
	`model` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`cache_read` integer,
	`cost_usd` real,
	`tool_calls` integer,
	`source` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_usage_events_identity` ON `usage_events` (`harness`,`agent`,`session`);--> statement-breakpoint
CREATE INDEX `idx_usage_events_task` ON `usage_events` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_usage_events_at` ON `usage_events` (`at`);