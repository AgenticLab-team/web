CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`url` text NOT NULL,
	`kind` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer NOT NULL,
	`filename` text,
	`ip` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `uploads_user_idx` ON `uploads` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `uploads_url_idx` ON `uploads` (`url`);