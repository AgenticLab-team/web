CREATE TABLE `preview_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`viewer_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`withheld` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ended_at` integer,
	`end_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `preview_sessions_token_idx` ON `preview_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `preview_sessions_viewer_idx` ON `preview_sessions` (`viewer_id`,`created_at`);