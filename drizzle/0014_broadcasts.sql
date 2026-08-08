CREATE TABLE `broadcast_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`broadcast_id` text NOT NULL,
	`conv_id` text NOT NULL,
	`conv_name` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`msg_svr_id` text,
	`error` text,
	`sent_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `broadcast_deliveries_bid_idx` ON `broadcast_deliveries` (`broadcast_id`);--> statement-breakpoint
CREATE TABLE `broadcasts` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`title` text,
	`content` text NOT NULL,
	`content_hash` text,
	`display` text,
	`target_role_id` text,
	`target_conv_ids` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_by` text NOT NULL,
	`submitted_at` integer,
	`approved_by` text,
	`approved_at` integer,
	`approve_note` text,
	`started_at` integer,
	`finished_at` integer,
	`sent_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`error` text,
	`expires_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `broadcasts_status_idx` ON `broadcasts` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `broadcasts_channel_idx` ON `broadcasts` (`channel`,`created_at`);