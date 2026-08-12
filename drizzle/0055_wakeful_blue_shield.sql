CREATE TABLE `api_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`token_id` text NOT NULL,
	`user_id` text NOT NULL,
	`conv_id` text NOT NULL,
	`length` integer NOT NULL,
	`ok` integer NOT NULL,
	`error` text,
	`msg_svr_id` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `api_sends_token_idx` ON `api_sends` (`token_id`,`at`);--> statement-breakpoint
CREATE INDEX `api_sends_conv_idx` ON `api_sends` (`conv_id`,`at`);--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`visible` text NOT NULL,
	`hash` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`revoked_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_hash_idx` ON `api_tokens` (`hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_user_idx` ON `api_tokens` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `group_send_grants` (
	`conv_id` text NOT NULL,
	`user_id` text NOT NULL,
	`granted_by` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_send_grants_pk` ON `group_send_grants` (`conv_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `group_send_grants_user_idx` ON `group_send_grants` (`user_id`);