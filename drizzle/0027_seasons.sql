CREATE TABLE `season_standings` (
	`id` text PRIMARY KEY NOT NULL,
	`season_id` text NOT NULL,
	`wx_id` text NOT NULL,
	`rank` integer NOT NULL,
	`quality` integer DEFAULT 0 NOT NULL,
	`messages` integer DEFAULT 0 NOT NULL,
	`chars` integer DEFAULT 0 NOT NULL,
	`awarded_title_key` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `season_standings_unique_idx` ON `season_standings` (`season_id`,`wx_id`);--> statement-breakpoint
CREATE INDEX `season_standings_rank_idx` ON `season_standings` (`season_id`,`rank`);--> statement-breakpoint
CREATE TABLE `seasons` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`settled_at` integer,
	`settle_note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seasons_key_idx` ON `seasons` (`key`);--> statement-breakpoint
CREATE INDEX `seasons_range_idx` ON `seasons` (`starts_at`,`ends_at`);