CREATE TABLE `github_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`github_user_id` text NOT NULL,
	`login` text NOT NULL,
	`name` text,
	`avatar_url` text,
	`html_url` text NOT NULL,
	`access_token` text,
	`scope` text DEFAULT '' NOT NULL,
	`show_on_profile` integer DEFAULT false NOT NULL,
	`pinned_repos` text,
	`prompt_enabled` integer DEFAULT true NOT NULL,
	`connected_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_connections_user_id_unique` ON `github_connections` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `github_connections_github_user_id_unique` ON `github_connections` (`github_user_id`);--> statement-breakpoint
CREATE INDEX `github_connections_login_idx` ON `github_connections` (`login`);--> statement-breakpoint
CREATE TABLE `github_repo_cache` (
	`user_id` text PRIMARY KEY NOT NULL,
	`repos` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`attempted_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `github_share_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject_key` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`summary` text,
	`repo_full_name` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`subject_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`post_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_prompts_subject_idx` ON `github_share_prompts` (`user_id`,`subject_key`);--> statement-breakpoint
CREATE INDEX `github_prompts_user_status_idx` ON `github_share_prompts` (`user_id`,`status`);