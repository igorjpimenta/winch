CREATE TABLE `deps` (
	`from_id` text NOT NULL,
	`from_kind` text NOT NULL,
	`to_id` text NOT NULL,
	`to_kind` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`from_id`, `to_id`),
	CONSTRAINT "deps_from_kind" CHECK("deps"."from_kind" IN ('epic', 'story', 'task')),
	CONSTRAINT "deps_to_kind" CHECK("deps"."to_kind" IN ('epic', 'story', 'task'))
);
--> statement-breakpoint
CREATE INDEX `idx_deps_from` ON `deps` (`from_id`);--> statement-breakpoint
CREATE INDEX `idx_deps_to` ON `deps` (`to_id`);--> statement-breakpoint
CREATE TABLE `epics` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`acceptance` text,
	`status` text NOT NULL,
	`owner_team` text,
	`priority` integer DEFAULT 50 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer,
	CONSTRAINT "epics_status" CHECK("epics"."status" IN ('idea', 'planned', 'in_progress', 'done', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`actor` text,
	`note` text,
	`session_ref` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_events_task` ON `events` (`task_id`);--> statement-breakpoint
CREATE TABLE `session_budgets` (
	`session_key` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`tool_calls` integer DEFAULT 0 NOT NULL,
	`limit_calls` integer NOT NULL,
	`exhausted_at` integer,
	`empty_wakes` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stories` (
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
	FOREIGN KEY (`epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stories_status" CHECK("stories"."status" IN ('backlog', 'ready', 'in_progress', 'review', 'done', 'blocked', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `idx_stories_epic` ON `stories` (`epic_id`);--> statement-breakpoint
CREATE INDEX `idx_stories_status_assigned` ON `stories` (`status`,`assigned`);--> statement-breakpoint
CREATE TABLE `tasks` (
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
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tasks_status" CHECK("tasks"."status" IN ('todo', 'in_progress', 'done', 'blocked', 'cancelled')),
	CONSTRAINT "tasks_execution_kind" CHECK("tasks"."execution_kind" IN ('pipeclaw', 'subagent', 'cli', 'gate', 'manual'))
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_story` ON `tasks` (`story_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status_assigned` ON `tasks` (`status`,`assigned`);