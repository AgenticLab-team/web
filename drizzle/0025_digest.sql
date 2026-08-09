CREATE TABLE `digest_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`week_start` text NOT NULL,
	`post_ids` text NOT NULL,
	`item_count` integer DEFAULT 0 NOT NULL,
	`broadcast_id` text,
	`skip_reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digest_runs_week_idx` ON `digest_runs` (`week_start`);--> statement-breakpoint
CREATE INDEX `digest_runs_created_idx` ON `digest_runs` (`created_at`);