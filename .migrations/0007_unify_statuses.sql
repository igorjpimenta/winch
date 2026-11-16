PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_item_state` (
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
	CONSTRAINT "item_state_status" CHECK("__new_item_state"."status" IN ('backlog', 'ready', 'in_progress', 'blocked', 'review', 'done', 'cancelled')),
	CONSTRAINT "item_state_assignment_pair" CHECK(("__new_item_state"."assignee_harness" IS NULL) = ("__new_item_state"."assignee_agent" IS NULL)),
	CONSTRAINT "item_state_ready_assigned" CHECK("__new_item_state"."status" <> 'ready' OR ("__new_item_state"."assignee_harness" IS NOT NULL AND "__new_item_state"."assignee_agent" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_item_state`("item_id", "revision", "status", "state_json", "assignee_harness", "assignee_agent", "updated_at", "closed_at", "deleted_at") SELECT "item_id", "revision", CASE
    WHEN "status" IN ('todo', 'planned') AND "assignee_harness" IS NOT NULL AND "assignee_agent" IS NOT NULL THEN 'ready'
    WHEN "status" IN ('todo', 'planned', 'idea') THEN 'backlog'
    WHEN "status" = 'ready' AND ("assignee_harness" IS NULL OR "assignee_agent" IS NULL) THEN 'backlog'
    ELSE "status" END, "state_json", "assignee_harness", "assignee_agent", "updated_at", "closed_at", "deleted_at" FROM `item_state`;--> statement-breakpoint
DROP TABLE `item_state`;--> statement-breakpoint
ALTER TABLE `__new_item_state` RENAME TO `item_state`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_state_ready` ON `item_state` (`status`,`assignee_harness`,`assignee_agent`);--> statement-breakpoint
CREATE INDEX `idx_state_updated` ON `item_state` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_state_deleted` ON `item_state` (`deleted_at`);