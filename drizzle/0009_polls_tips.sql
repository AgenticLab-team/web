CREATE TABLE `forum_poll_options` (
	`id` text PRIMARY KEY NOT NULL,
	`poll_id` text NOT NULL,
	`text` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`votes` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `forum_poll_options_poll_idx` ON `forum_poll_options` (`poll_id`,`sort`);--> statement-breakpoint
CREATE TABLE `forum_poll_votes` (
	`id` text PRIMARY KEY NOT NULL,
	`poll_id` text NOT NULL,
	`option_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forum_poll_votes_unique_idx` ON `forum_poll_votes` (`poll_id`,`option_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `forum_poll_votes_user_idx` ON `forum_poll_votes` (`poll_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `forum_polls` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`question` text,
	`multi` integer DEFAULT false NOT NULL,
	`anonymous` integer DEFAULT true NOT NULL,
	`hide_until_voted` integer DEFAULT false NOT NULL,
	`closes_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forum_polls_post_id_unique` ON `forum_polls` (`post_id`);--> statement-breakpoint
CREATE INDEX `forum_polls_post_idx` ON `forum_polls` (`post_id`);--> statement-breakpoint
CREATE TABLE `forum_tips` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`post_id` text NOT NULL,
	`from_user_id` text NOT NULL,
	`to_user_id` text NOT NULL,
	`points` integer NOT NULL,
	`note` text,
	`ledger_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `forum_tips_target_idx` ON `forum_tips` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `forum_tips_to_idx` ON `forum_tips` (`to_user_id`,`created_at`);