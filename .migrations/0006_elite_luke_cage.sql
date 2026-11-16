CREATE TABLE `__new_epics` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`acceptance` text,
	`status` text NOT NULL,
	`created_by` text,
	`owner_team` text,
	`priority` integer DEFAULT 50 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer,
	CONSTRAINT "epics_status" CHECK("__new_epics"."status" IN ('backlog', 'ready', 'in_progress', 'blocked', 'review', 'done', 'cancelled'))
);
--> statement-breakpoint
INSERT INTO `__new_epics`("id", "title", "description", "acceptance", "status", "created_by", "owner_team", "priority", "created_at", "updated_at", "closed_at") SELECT "id", "title", "description", "acceptance", CASE "status" WHEN 'idea' THEN 'backlog' WHEN 'planned' THEN 'ready' ELSE "status" END, "created_by", "owner_team", "priority", "created_at", "updated_at", "closed_at" FROM `epics`;
--> statement-breakpoint
CREATE TABLE `__new_stories` (
	`id` text PRIMARY KEY NOT NULL,
	`epic_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`acceptance` text,
	`status` text NOT NULL,
	`size` text,
	`priority` integer DEFAULT 50 NOT NULL,
	`assigned` text,
	`capabilities` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`epic_id`) REFERENCES `__new_epics`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stories_status" CHECK("__new_stories"."status" IN ('backlog', 'ready', 'in_progress', 'blocked', 'review', 'done', 'cancelled'))
);
--> statement-breakpoint
INSERT INTO `__new_stories`("id", "epic_id", "title", "description", "acceptance", "status", "size", "priority", "assigned", "capabilities", "created_at", "updated_at", "closed_at") SELECT "id", "epic_id", "title", "description", "acceptance", "status", "size", "priority", "assigned", "capabilities", "created_at", "updated_at", "closed_at" FROM `stories`;
--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`story_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`execution_kind` text NOT NULL,
	`execution_args` text DEFAULT '{}' NOT NULL,
	`assigned` text,
	`capabilities` text,
	`flow_id` text,
	`task_run_id` text,
	`claim_expires_at` integer,
	`lease_seconds` integer,
	`last_heartbeat` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`gate_type` text,
	`blocked_at` integer,
	`result_summary` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`claimed_at` integer,
	`closed_at` integer,
	FOREIGN KEY (`story_id`) REFERENCES `__new_stories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tasks_status" CHECK("__new_tasks"."status" IN ('backlog', 'ready', 'in_progress', 'blocked', 'review', 'done', 'cancelled')),
	CONSTRAINT "tasks_execution_kind" CHECK("__new_tasks"."execution_kind" IN ('pipeclaw', 'subagent', 'cli', 'gate', 'manual'))
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "story_id", "title", "description", "status", "execution_kind", "execution_args", "assigned", "capabilities", "flow_id", "task_run_id", "claim_expires_at", "lease_seconds", "last_heartbeat", "attempt_count", "gate_type", "blocked_at", "result_summary", "created_at", "updated_at", "claimed_at", "closed_at") SELECT "id", "story_id", "title", "description", CASE "status" WHEN 'todo' THEN 'ready' ELSE "status" END, "execution_kind", "execution_args", "assigned", "capabilities", "flow_id", "task_run_id", "claim_expires_at", "lease_seconds", "last_heartbeat", "attempt_count", "gate_type", "blocked_at", "result_summary", "created_at", "updated_at", "claimed_at", "closed_at" FROM `tasks`;
--> statement-breakpoint
DROP TABLE `tasks`;
--> statement-breakpoint
DROP TABLE `stories`;
--> statement-breakpoint
DROP TABLE `epics`;
--> statement-breakpoint
ALTER TABLE `__new_epics` RENAME TO `epics`;
--> statement-breakpoint
ALTER TABLE `__new_stories` RENAME TO `stories`;
--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;
--> statement-breakpoint
CREATE INDEX `idx_stories_epic` ON `stories` (`epic_id`);
--> statement-breakpoint
CREATE INDEX `idx_stories_status_assigned` ON `stories` (`status`,`assigned`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_story` ON `tasks` (`story_id`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_status_assigned` ON `tasks` (`status`,`assigned`);
