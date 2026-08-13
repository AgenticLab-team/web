DROP INDEX `digest_runs_week_idx`;--> statement-breakpoint
ALTER TABLE `digest_runs` ADD `kind` text DEFAULT 'weekly' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `digest_runs_kind_period_idx` ON `digest_runs` (`kind`,`week_start`);