CREATE TABLE `announcement_dismissals` (
	`user_id` text NOT NULL,
	`broadcast_id` text NOT NULL,
	`dismissed_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `broadcast_id`)
);
--> statement-breakpoint
CREATE INDEX `announcement_dismissals_user_idx` ON `announcement_dismissals` (`user_id`);--> statement-breakpoint
CREATE INDEX `announcement_dismissals_broadcast_idx` ON `announcement_dismissals` (`broadcast_id`);