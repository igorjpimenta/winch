CREATE TABLE `dispatch_delivery_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`delivery_id` integer NOT NULL,
	`attempt_no` integer NOT NULL,
	`status` text NOT NULL,
	`response_status` integer,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`delivery_id`) REFERENCES `dispatch_deliveries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_delivery_attempts_delivery` ON `dispatch_delivery_attempts` (`delivery_id`,`attempt_no`);--> statement-breakpoint
CREATE TABLE `dispatch_events` (
	`id` text PRIMARY KEY NOT NULL,
	`admission_id` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`item_id` text NOT NULL,
	`source_event_id` integer,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`published_at` integer,
	FOREIGN KEY (`admission_id`) REFERENCES `admission_queue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dispatch_event_attempt` ON `dispatch_events` (`admission_id`,`attempt_no`);--> statement-breakpoint
CREATE INDEX `idx_dispatch_events_created` ON `dispatch_events` (`created_at`);--> statement-breakpoint
ALTER TABLE `attempts` ADD `owner_instance` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `lease_epoch` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `dispatch_deliveries` ADD `event_id` text;--> statement-breakpoint
CREATE INDEX `idx_delivery_event` ON `dispatch_deliveries` (`event_id`,`consumer_id`);--> statement-breakpoint
ALTER TABLE `webhooks` ADD `managed` integer DEFAULT 0 NOT NULL;