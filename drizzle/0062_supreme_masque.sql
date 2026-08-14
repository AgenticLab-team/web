CREATE TABLE `device_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_code_hash` text NOT NULL,
	`device_code_hash` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`device_label` text NOT NULL,
	`request_ip` text,
	`scopes` text NOT NULL,
	`ssh_key_fingerprint` text,
	`approved_by_user_id` text,
	`approved_at` integer,
	`wrong_code_tries` integer DEFAULT 0 NOT NULL,
	`last_polled_at` integer,
	`poll_interval` integer DEFAULT 5 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_user_code_idx` ON `device_codes` (`user_code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_device_code_idx` ON `device_codes` (`device_code_hash`);--> statement-breakpoint
CREATE INDEX `device_codes_expires_idx` ON `device_codes` (`expires_at`);--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `device_label` text;