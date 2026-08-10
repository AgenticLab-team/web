CREATE TABLE `person_phrases` (
	`wx_id` text NOT NULL,
	`conv_id` text NOT NULL,
	`phrase` text NOT NULL,
	`hits` integer NOT NULL,
	`msgs` integer NOT NULL,
	`days` integer NOT NULL,
	`lift` real NOT NULL,
	`score` real NOT NULL,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`wx_id`, `conv_id`)
);
