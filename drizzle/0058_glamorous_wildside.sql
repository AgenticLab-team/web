ALTER TABLE `forum_posts` ADD `repo_ref` text;--> statement-breakpoint
CREATE INDEX `forum_posts_repo_idx` ON `forum_posts` (`repo_ref`,`created_at`);--> statement-breakpoint
ALTER TABLE `github_facts` ADD `body` text;