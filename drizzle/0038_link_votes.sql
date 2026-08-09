CREATE TABLE `link_votes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`link_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `link_votes_user_idx` ON `link_votes` (`user_id`,`link_id`);--> statement-breakpoint
CREATE INDEX `link_votes_link_idx` ON `link_votes` (`link_id`);--> statement-breakpoint
ALTER TABLE `links` ADD `vote_count` integer DEFAULT 0 NOT NULL;