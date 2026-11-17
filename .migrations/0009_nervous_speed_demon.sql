CREATE TABLE `dispatch_webhooks` (
	`harness` text NOT NULL,
	`executor_id` text NOT NULL,
	`url` text NOT NULL,
	`bearer` text NOT NULL,
	`timeout_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	PRIMARY KEY(`harness`, `executor_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_dispatch_webhooks_harness` ON `dispatch_webhooks` (`harness`,`last_seen_at`);