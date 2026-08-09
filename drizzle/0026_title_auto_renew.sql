ALTER TABLE `user_titles` ADD `auto_renew` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `user_titles` ADD `renew_notified_at` integer;