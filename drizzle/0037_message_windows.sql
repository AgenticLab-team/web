CREATE TABLE `message_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`window_key` text NOT NULL,
	`conv_id` text NOT NULL,
	`start_ts` integer NOT NULL,
	`end_ts` integer NOT NULL,
	`message_count` integer NOT NULL,
	`message_ids` text NOT NULL,
	`text` text NOT NULL,
	`vector` blob,
	`model` text,
	`dimensions` integer,
	`embedded_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_windows_key_idx` ON `message_windows` (`window_key`);--> statement-breakpoint
CREATE INDEX `message_windows_conv_idx` ON `message_windows` (`conv_id`,`start_ts`);--> statement-breakpoint
CREATE INDEX `message_windows_pending_idx` ON `message_windows` (`embedded_at`);