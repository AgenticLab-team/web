CREATE TABLE `visibility_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`from_visibility` text NOT NULL,
	`to_visibility` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`consent_required` integer DEFAULT 0 NOT NULL,
	`consent_granted` integer DEFAULT 0 NOT NULL,
	`reviewed_by` text,
	`reviewed_at` integer,
	`review_note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `visibility_requests_status_idx` ON `visibility_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `visibility_requests_post_idx` ON `visibility_requests` (`post_id`);