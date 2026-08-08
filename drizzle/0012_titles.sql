CREATE TABLE `titles` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`icon` text,
	`color` text,
	`rarity` text DEFAULT 'common' NOT NULL,
	`source` text DEFAULT 'grant' NOT NULL,
	`price` integer,
	`rent_days` integer,
	`condition_kind` text,
	`condition_value` integer,
	`limit_count` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `titles_key_unique` ON `titles` (`key`);--> statement-breakpoint
CREATE INDEX `titles_sort_idx` ON `titles` (`sort`);--> statement-breakpoint
CREATE INDEX `titles_source_idx` ON `titles` (`source`);--> statement-breakpoint
CREATE TABLE `user_titles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title_id` text NOT NULL,
	`source` text DEFAULT 'grant' NOT NULL,
	`granted_by` text,
	`grant_reason` text,
	`price_paid` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`revoked_by` text,
	`revoke_reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `user_titles_user_idx` ON `user_titles` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `user_titles_title_idx` ON `user_titles` (`title_id`,`revoked_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_titles_unique_idx` ON `user_titles` (`user_id`,`title_id`,`revoked_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `active_title_id` text;