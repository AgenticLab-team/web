CREATE TABLE `appeals` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`action_id` text NOT NULL,
	`content` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`handled_by` text,
	`handled_at` integer,
	`response` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `appeals_status_idx` ON `appeals` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `appeals_user_idx` ON `appeals` (`user_id`);--> statement-breakpoint
CREATE TABLE `moderation_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`target_user_id` text,
	`action` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text,
	`duration_seconds` integer,
	`expires_at` integer,
	`report_id` text,
	`reverted_by` text,
	`reverted_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `moderation_actions_target_user_idx` ON `moderation_actions` (`target_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `moderation_actions_target_idx` ON `moderation_actions` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `moderation_actions_actor_idx` ON `moderation_actions` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`target_user_id` text,
	`reason_code` text NOT NULL,
	`detail` text,
	`status` text DEFAULT 'open' NOT NULL,
	`severity` integer DEFAULT 0 NOT NULL,
	`assigned_to` text,
	`resolved_by` text,
	`resolved_at` integer,
	`resolution` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reports_status_idx` ON `reports` (`status`,`severity`,`created_at`);--> statement-breakpoint
CREATE INDEX `reports_target_idx` ON `reports` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `reports_reporter_idx` ON `reports` (`reporter_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sensitive_words` (
	`id` text PRIMARY KEY NOT NULL,
	`word` text NOT NULL,
	`kind` text DEFAULT 'review' NOT NULL,
	`replacement` text,
	`enabled` integer DEFAULT true NOT NULL,
	`hit_count` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sensitive_words_word_unique` ON `sensitive_words` (`word`);--> statement-breakpoint
CREATE INDEX `sensitive_words_enabled_idx` ON `sensitive_words` (`enabled`);