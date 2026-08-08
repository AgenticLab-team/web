CREATE TABLE `checkins` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`points_awarded` integer NOT NULL,
	`base_points` integer NOT NULL,
	`quality_bonus` integer DEFAULT 0 NOT NULL,
	`streak_bonus` integer DEFAULT 0 NOT NULL,
	`quality_raw` integer DEFAULT 0 NOT NULL,
	`quality_counted` integer DEFAULT 0 NOT NULL,
	`streak_after` integer DEFAULT 1 NOT NULL,
	`is_makeup` integer DEFAULT false NOT NULL,
	`makeup_cost` integer,
	`ip` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkins_user_date_idx` ON `checkins` (`user_id`,`date`);--> statement-breakpoint
CREATE TABLE `points_anomalies` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`detail` text,
	`score` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`reviewed_by` text,
	`reviewed_at` integer,
	`resolution` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `points_anomalies_status_idx` ON `points_anomalies` (`status`,`created_at`);