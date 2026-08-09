CREATE TABLE `backup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`files` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`detail` text,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `backup_runs_kind_idx` ON `backup_runs` (`kind`,`status`,`created_at`);