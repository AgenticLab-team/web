CREATE TABLE `oauth_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_hash` text,
	`name` text NOT NULL,
	`description` text,
	`homepage` text,
	`redirect_uri` text NOT NULL,
	`owner_admin_id` text NOT NULL,
	`allow_send` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_apps_client_id_idx` ON `oauth_apps` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauth_apps_owner_idx` ON `oauth_apps` (`owner_admin_id`);--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scopes` text NOT NULL,
	`code_challenge` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_codes_expires_idx` ON `oauth_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_grants_app_user_idx` ON `oauth_grants` (`app_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `oauth_grants_user_idx` ON `oauth_grants` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_refresh_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`access_token_id` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_refresh_grant_idx` ON `oauth_refresh_tokens` (`grant_id`);