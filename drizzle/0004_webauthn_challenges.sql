CREATE TABLE `webauthn_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	`kind` text NOT NULL,
	`user_id` text,
	`ip` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE INDEX `webauthn_challenges_challenge_idx` ON `webauthn_challenges` (`challenge`);--> statement-breakpoint
CREATE INDEX `webauthn_challenges_expires_idx` ON `webauthn_challenges` (`expires_at`);