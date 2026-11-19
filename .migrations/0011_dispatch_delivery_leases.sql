CREATE TABLE `dispatch_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`admission_id` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`consumer_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_at` integer NOT NULL,
	`last_status` integer,
	`last_error` text,
	`delivered_at` integer,
	`dead_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`admission_id`) REFERENCES `admission_queue`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "delivery_status" CHECK("dispatch_deliveries"."status" IN ('pending', 'delivering', 'delivered', 'dead', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_delivery_grain` ON `dispatch_deliveries` (`admission_id`,`attempt_no`,`consumer_id`);--> statement-breakpoint
CREATE INDEX `idx_delivery_due` ON `dispatch_deliveries` (`status`,`next_at`);--> statement-breakpoint
CREATE INDEX `idx_delivery_attempt` ON `dispatch_deliveries` (`admission_id`,`attempt_no`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_webhooks` (
	`topic` text NOT NULL,
	`id` text NOT NULL,
	`harness` text,
	`executor_id` text,
	`url` text NOT NULL,
	`bearer` text NOT NULL,
	`timeout_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`instance_id` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`disabled_at` integer,
	`lease_until` integer,
	PRIMARY KEY(`topic`, `id`),
	CONSTRAINT "webhooks_state" CHECK("__new_webhooks"."state" IN ('active', 'suspect', 'disabled'))
);
--> statement-breakpoint
INSERT INTO `__new_webhooks`("topic", "id", "harness", "executor_id", "url", "bearer", "timeout_ms", "created_at", "updated_at", "last_seen_at", "instance_id", "generation", "state", "failure_count", "last_error", "disabled_at", "lease_until") SELECT "topic", "id", "harness", "executor_id", "url", "bearer", "timeout_ms", "created_at", "updated_at", "last_seen_at", NULL, 0, 'active', 0, NULL, NULL, NULL FROM `webhooks`;--> statement-breakpoint
DROP TABLE `webhooks`;--> statement-breakpoint
ALTER TABLE `__new_webhooks` RENAME TO `webhooks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_webhooks_topic_harness` ON `webhooks` (`topic`,`harness`,`state`,`last_seen_at`);--> statement-breakpoint
ALTER TABLE `admission_attempts` ADD `active_consumer_id` text;--> statement-breakpoint
ALTER TABLE `admission_attempts` ADD `lease_epoch` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `admission_attempts` ADD `lease_until` integer;--> statement-breakpoint
ALTER TABLE `attempts` ADD `consumer_id` text;