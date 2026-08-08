CREATE TABLE `invite_uses` (
	`id` text PRIMARY KEY NOT NULL,
	`invite_id` text NOT NULL,
	`inviter_id` text NOT NULL,
	`invited_user_id` text NOT NULL,
	`ip` text,
	`rewarded_at` integer,
	`reward_points` integer,
	`reverted_at` integer,
	`revert_reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invite_uses_user_idx` ON `invite_uses` (`invited_user_id`);--> statement-breakpoint
CREATE INDEX `invite_uses_invite_idx` ON `invite_uses` (`invite_id`);--> statement-breakpoint
CREATE INDEX `invite_uses_inviter_idx` ON `invite_uses` (`inviter_id`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`created_by` text NOT NULL,
	`note` text,
	`max_uses` integer,
	`used_count` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`grant_role_id` text,
	`grant_kind` text DEFAULT 'external' NOT NULL,
	`revoked_at` integer,
	`revoked_by` text,
	`revoke_reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_code_unique` ON `invites` (`code`);--> statement-breakpoint
CREATE INDEX `invites_creator_idx` ON `invites` (`created_by`,`created_at`);--> statement-breakpoint
CREATE INDEX `invites_active_idx` ON `invites` (`revoked_at`,`expires_at`);