CREATE TABLE `data_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`with_context` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'started' NOT NULL,
	`own_messages` integer DEFAULT 0 NOT NULL,
	`context_messages` integer DEFAULT 0 NOT NULL,
	`windows` integer DEFAULT 0 NOT NULL,
	`posts` integer DEFAULT 0 NOT NULL,
	`replies` integer DEFAULT 0 NOT NULL,
	`drafts` integer DEFAULT 0 NOT NULL,
	`interactions` integer DEFAULT 0 NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `data_exports_user_idx` ON `data_exports` (`user_id`,`started_at`);