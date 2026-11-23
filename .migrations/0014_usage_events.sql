CREATE TABLE `usage_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` text NOT NULL,
	`session_id` text,
	`attempt_id` text,
	`harness` text NOT NULL,
	`agent_id` text NOT NULL,
	`external_session_id` text NOT NULL,
	`model` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`cache_read` integer,
	`cost_usd` real,
	`tool_calls` integer,
	`source` text DEFAULT 'api' NOT NULL,
	`turn_ref` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `work_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "usage_source" CHECK("usage_events"."source" IN ('api')),
	CONSTRAINT "usage_nonneg" CHECK(("usage_events"."tokens_in" IS NULL OR "usage_events"."tokens_in" >= 0) AND ("usage_events"."tokens_out" IS NULL OR "usage_events"."tokens_out" >= 0) AND ("usage_events"."cache_read" IS NULL OR "usage_events"."cache_read" >= 0) AND ("usage_events"."cost_usd" IS NULL OR "usage_events"."cost_usd" >= 0) AND ("usage_events"."tool_calls" IS NULL OR "usage_events"."tool_calls" >= 0))
);
--> statement-breakpoint
CREATE INDEX `idx_usage_item` ON `usage_events` (`item_id`);--> statement-breakpoint
CREATE INDEX `idx_usage_session` ON `usage_events` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_usage_attempt` ON `usage_events` (`attempt_id`);--> statement-breakpoint
CREATE INDEX `idx_usage_created` ON `usage_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_usage_identity` ON `usage_events` (`harness`,`agent_id`,`external_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_usage_turn` ON `usage_events` (`harness`,`agent_id`,`external_session_id`,`turn_ref`) WHERE "usage_events"."turn_ref" IS NOT NULL;