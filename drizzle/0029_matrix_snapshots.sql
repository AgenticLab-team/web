CREATE TABLE `matrix_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`cells` text NOT NULL,
	`change_count` integer NOT NULL,
	`change_summary` text NOT NULL,
	`reason` text NOT NULL,
	`taken_by` text NOT NULL,
	`is_rollback` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `matrix_snapshots_time_idx` ON `matrix_snapshots` (`created_at`);