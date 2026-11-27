CREATE TABLE `resume_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` text NOT NULL,
	`attempt_no` integer,
	`attempt_key` text NOT NULL,
	`consumer_id` text NOT NULL,
	`handed_at` integer NOT NULL,
	`settled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_resume_grain` ON `resume_deliveries` (`item_id`,`attempt_key`,`consumer_id`);--> statement-breakpoint
CREATE INDEX `idx_resume_consumer` ON `resume_deliveries` (`consumer_id`,`handed_at`);