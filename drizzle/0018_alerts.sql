CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`component` text NOT NULL,
	`severity` text DEFAULT 'warning' NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`state` text DEFAULT 'firing' NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`resolved_at` integer,
	`notified_at` integer,
	`notify_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alerts_state_idx` ON `alerts` (`state`,`first_seen_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_firing_idx` ON `alerts` (`component`) WHERE "alerts"."state" = 'firing';