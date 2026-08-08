CREATE TABLE `people` (
	`wx_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`avatar_url` text,
	`avatar_source` text,
	`messages` integer DEFAULT 0 NOT NULL,
	`quality_messages` integer DEFAULT 0 NOT NULL,
	`group_count` integer DEFAULT 0 NOT NULL,
	`first_seen` integer,
	`last_seen` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `people_name_idx` ON `people` (`display_name`);