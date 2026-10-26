CREATE TABLE `webhook_targets` (
	`harness` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`bearer` text,
	`timeout_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
