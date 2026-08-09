CREATE TABLE `link_mentions` (
	`id` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`conv_id` text NOT NULL,
	`message_id` text,
	`sharer_wx_id` text,
	`sharer_name` text,
	`shared_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `link_mentions_msg_idx` ON `link_mentions` (`link_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `link_mentions_link_idx` ON `link_mentions` (`link_id`,`shared_at`);--> statement-breakpoint
CREATE INDEX `link_mentions_conv_idx` ON `link_mentions` (`conv_id`,`shared_at`);--> statement-breakpoint
CREATE TABLE `link_saves` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`link_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `link_saves_user_idx` ON `link_saves` (`user_id`,`link_id`);--> statement-breakpoint
CREATE TABLE `links` (
	`id` text PRIMARY KEY NOT NULL,
	`url_key` text NOT NULL,
	`url` text NOT NULL,
	`domain` text NOT NULL,
	`title` text NOT NULL,
	`note` text,
	`share_count` integer DEFAULT 1 NOT NULL,
	`first_shared_at` integer NOT NULL,
	`last_shared_at` integer NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`hidden_reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `links_key_idx` ON `links` (`url_key`);--> statement-breakpoint
CREATE INDEX `links_domain_idx` ON `links` (`domain`,`last_shared_at`);--> statement-breakpoint
CREATE INDEX `links_recent_idx` ON `links` (`hidden`,`last_shared_at`);