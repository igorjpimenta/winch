CREATE TABLE `webhooks` (
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
	PRIMARY KEY(`topic`, `id`)
);
--> statement-breakpoint
CREATE INDEX `idx_webhooks_topic_harness` ON `webhooks` (`topic`,`harness`,`last_seen_at`);--> statement-breakpoint
DROP TABLE `harness_webhooks`;--> statement-breakpoint
DROP TABLE IF EXISTS `dispatch_webhooks`;
