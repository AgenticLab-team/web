CREATE TABLE `forum_bookmark_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `forum_bookmark_folders_user_idx` ON `forum_bookmark_folders` (`user_id`);--> statement-breakpoint
CREATE TABLE `forum_bookmarks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`post_id` text NOT NULL,
	`folder_id` text,
	`note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forum_bookmarks_unique_idx` ON `forum_bookmarks` (`user_id`,`post_id`);--> statement-breakpoint
CREATE INDEX `forum_bookmarks_user_idx` ON `forum_bookmarks` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `notification_prefs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`channels` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`group_key` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`link` text,
	`actor_id` text,
	`actor_name` text,
	`ref_type` text,
	`ref_id` text,
	`read_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`,`read_at`,`updated_at`);--> statement-breakpoint
CREATE INDEX `notifications_group_idx` ON `notifications` (`user_id`,`group_key`,`read_at`);--> statement-breakpoint
CREATE TABLE `forum_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`auto` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`muted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forum_subscriptions_unique_idx` ON `forum_subscriptions` (`user_id`,`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `forum_subscriptions_target_idx` ON `forum_subscriptions` (`target_type`,`target_id`);