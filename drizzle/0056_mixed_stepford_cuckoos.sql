ALTER TABLE `api_sends` ADD `text` text;--> statement-breakpoint
ALTER TABLE `group_send_grants` ADD `per_minute` integer;--> statement-breakpoint
ALTER TABLE `group_send_grants` ADD `per_hour` integer;--> statement-breakpoint
ALTER TABLE `group_send_grants` ADD `per_day` integer;