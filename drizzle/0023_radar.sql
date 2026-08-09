CREATE TABLE `keyword_hits` (
	`id` text PRIMARY KEY NOT NULL,
	`sub_id` text NOT NULL,
	`message_id` text NOT NULL,
	`conv_id` text NOT NULL,
	`sender_name` text,
	`snippet` text,
	`notified` integer DEFAULT false NOT NULL,
	`hit_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `keyword_hits_sub_msg_idx` ON `keyword_hits` (`sub_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `keyword_hits_sub_idx` ON `keyword_hits` (`sub_id`,`hit_at`);--> statement-breakpoint
CREATE TABLE `keyword_subs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`keyword` text NOT NULL,
	`keyword_key` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`hits_7d_at_create` integer DEFAULT 0 NOT NULL,
	`hits_today` integer DEFAULT 0 NOT NULL,
	`last_notified_at` integer,
	`total_hits` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `keyword_subs_user_key_idx` ON `keyword_subs` (`user_id`,`keyword_key`);--> statement-breakpoint
CREATE INDEX `keyword_subs_enabled_idx` ON `keyword_subs` (`enabled`);