CREATE TABLE `github_facts` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`checked_at` integer NOT NULL,
	`gone` integer DEFAULT false NOT NULL
);
