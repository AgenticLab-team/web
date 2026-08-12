PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_api_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`token_id` text,
	`user_id` text NOT NULL,
	`conv_id` text NOT NULL,
	`length` integer NOT NULL,
	`text` text,
	`ok` integer NOT NULL,
	`error` text,
	`msg_svr_id` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_api_sends`("id", "token_id", "user_id", "conv_id", "length", "text", "ok", "error", "msg_svr_id", "at") SELECT "id", "token_id", "user_id", "conv_id", "length", "text", "ok", "error", "msg_svr_id", "at" FROM `api_sends`;--> statement-breakpoint
DROP TABLE `api_sends`;--> statement-breakpoint
ALTER TABLE `__new_api_sends` RENAME TO `api_sends`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `api_sends_user_idx` ON `api_sends` (`user_id`,`at`);--> statement-breakpoint
CREATE INDEX `api_sends_user_conv_idx` ON `api_sends` (`user_id`,`conv_id`,`at`);--> statement-breakpoint
CREATE INDEX `api_sends_token_idx` ON `api_sends` (`token_id`,`at`);--> statement-breakpoint
CREATE INDEX `api_sends_conv_idx` ON `api_sends` (`conv_id`,`at`);