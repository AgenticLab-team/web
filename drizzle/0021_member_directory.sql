CREATE TABLE `user_skills` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`slug` text NOT NULL,
	`label` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_skills_user_slug_idx` ON `user_skills` (`user_id`,`slug`);--> statement-breakpoint
CREATE INDEX `user_skills_slug_idx` ON `user_skills` (`slug`);--> statement-breakpoint
ALTER TABLE `users` ADD `directory_hidden` integer DEFAULT false NOT NULL;