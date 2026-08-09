CREATE TABLE `join_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`wx_id` text NOT NULL,
	`reason` text NOT NULL,
	`contact` text,
	`ip` text,
	`user_agent` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`handled_by` text,
	`handled_at` integer,
	`note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `join_requests_status_idx` ON `join_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `join_requests_ip_idx` ON `join_requests` (`ip`,`created_at`);--> statement-breakpoint
CREATE INDEX `join_requests_wx_idx` ON `join_requests` (`wx_id`);