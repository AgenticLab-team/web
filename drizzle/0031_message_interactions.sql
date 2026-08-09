CREATE TABLE `message_mentions` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`conv_id` text NOT NULL,
	`ts` integer NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`wx_id` text,
	`candidates` text,
	`position` integer NOT NULL,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_mentions_msg_pos_idx` ON `message_mentions` (`message_id`,`position`);--> statement-breakpoint
CREATE INDEX `message_mentions_wx_ts_idx` ON `message_mentions` (`wx_id`,`ts`);--> statement-breakpoint
CREATE INDEX `message_mentions_conv_ts_idx` ON `message_mentions` (`conv_id`,`ts`);--> statement-breakpoint
ALTER TABLE `messages` ADD `reply_to_id` text;--> statement-breakpoint
CREATE INDEX `messages_reply_to_idx` ON `messages` (`reply_to_id`);