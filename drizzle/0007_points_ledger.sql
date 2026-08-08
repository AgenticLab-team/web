CREATE TABLE `points_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`delta` integer NOT NULL,
	`balance_after` integer NOT NULL,
	`rule_key` text,
	`reason` text NOT NULL,
	`ref_type` text,
	`ref_id` text,
	`operator_id` text,
	`reverts_id` text,
	`reverted_by` text,
	`idempotency_key` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `points_ledger_user_idx` ON `points_ledger` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `points_ledger_ref_idx` ON `points_ledger` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `points_ledger_idempotency_idx` ON `points_ledger` (`idempotency_key`);