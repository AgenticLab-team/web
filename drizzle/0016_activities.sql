CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`module_key` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`rules_md` text,
	`config` text,
	`eligibility` text,
	`quota_total` integer,
	`quota_used` integer DEFAULT 0 NOT NULL,
	`per_user_limit` integer DEFAULT 1 NOT NULL,
	`allow_waitlist` integer DEFAULT true NOT NULL,
	`waitlist_cap` integer,
	`opens_at` integer,
	`closes_at` integer,
	`fulfill_deadline` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`result_public` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`cancelled_by` text,
	`cancel_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activities_status_idx` ON `activities` (`status`,`opens_at`);--> statement-breakpoint
CREATE INDEX `activities_module_idx` ON `activities` (`module_key`);--> statement-breakpoint
CREATE TABLE `activity_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`user_id` text NOT NULL,
	`payload` text,
	`normalized_key` text,
	`status` text DEFAULT 'submitted' NOT NULL,
	`eligibility_snapshot` text,
	`validation_result` text,
	`queue_position` integer,
	`reviewed_by` text,
	`reviewed_at` integer,
	`review_note` text,
	`fulfilled_at` integer,
	`fulfill_result` text,
	`failure_reason` text,
	`retry_of` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_applications_activity_idx` ON `activity_applications` (`activity_id`,`status`);--> statement-breakpoint
CREATE INDEX `activity_applications_user_idx` ON `activity_applications` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `activity_applications_key_idx` ON `activity_applications` (`activity_id`,`normalized_key`) WHERE "activity_applications"."normalized_key" IS NOT NULL AND "activity_applications"."status" NOT IN ('invalid','rejected','cancelled','expired','failed');--> statement-breakpoint
CREATE TABLE `activity_events` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`application_id` text,
	`from_status` text,
	`to_status` text NOT NULL,
	`actor_id` text,
	`actor_kind` text DEFAULT 'system' NOT NULL,
	`note` text,
	`payload` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_events_app_idx` ON `activity_events` (`application_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `activity_quota_log` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`delta` integer NOT NULL,
	`balance_after` integer NOT NULL,
	`reason` text NOT NULL,
	`application_id` text,
	`operator_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_quota_log_activity_idx` ON `activity_quota_log` (`activity_id`,`created_at`);