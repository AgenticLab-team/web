CREATE TABLE `forum_boards` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`icon` text,
	`color` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`parent_id` text,
	`visible_to` text DEFAULT 'member' NOT NULL,
	`default_visibility` text DEFAULT 'member' NOT NULL,
	`max_visibility` text DEFAULT 'member' NOT NULL,
	`post_permission` text,
	`reply_permission` text,
	`post_min_level` integer DEFAULT 1 NOT NULL,
	`allow_anonymous` integer DEFAULT false NOT NULL,
	`require_tags` integer DEFAULT false NOT NULL,
	`view_mode` text DEFAULT 'flat' NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`post_count` integer DEFAULT 0 NOT NULL,
	`last_post_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forum_boards_key_unique` ON `forum_boards` (`key`);--> statement-breakpoint
CREATE INDEX `forum_boards_sort_idx` ON `forum_boards` (`sort`);--> statement-breakpoint
CREATE TABLE `forum_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`board_id` text,
	`title` text,
	`content` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forum_drafts_unique_idx` ON `forum_drafts` (`user_id`,`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `forum_post_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`editor_id` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`change_note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `forum_post_revisions_post_idx` ON `forum_post_revisions` (`post_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `forum_post_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`conv_id` text NOT NULL,
	`message_ids` text NOT NULL,
	`converted_by` text NOT NULL,
	`converted_at` integer NOT NULL,
	`consent_status` text DEFAULT 'pending' NOT NULL,
	`consent_log` text
);
--> statement-breakpoint
CREATE INDEX `forum_post_sources_post_idx` ON `forum_post_sources` (`post_id`);--> statement-breakpoint
CREATE TABLE `forum_post_tags` (
	`post_id` text NOT NULL,
	`tag_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forum_post_tags_pk` ON `forum_post_tags` (`post_id`,`tag_id`);--> statement-breakpoint
CREATE INDEX `forum_post_tags_tag_idx` ON `forum_post_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `forum_post_views` (
	`post_id` text NOT NULL,
	`user_id` text NOT NULL,
	`last_read_floor` integer DEFAULT 0 NOT NULL,
	`read_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forum_post_views_pk` ON `forum_post_views` (`post_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `forum_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`author_id` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`content_html` text NOT NULL,
	`excerpt` text,
	`type` text DEFAULT 'discussion' NOT NULL,
	`status` text DEFAULT 'published' NOT NULL,
	`visibility` text DEFAULT 'member' NOT NULL,
	`visibility_role_id` text,
	`visibility_group_id` text,
	`visibility_locked` integer DEFAULT false NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`pinned_until` integer,
	`pinned_globally` integer DEFAULT false NOT NULL,
	`featured` integer DEFAULT false NOT NULL,
	`featured_by` text,
	`featured_at` integer,
	`anonymous` integer DEFAULT false NOT NULL,
	`solved_reply_id` text,
	`bounty_points` integer DEFAULT 0 NOT NULL,
	`view_count` integer DEFAULT 0 NOT NULL,
	`reply_count` integer DEFAULT 0 NOT NULL,
	`reaction_count` integer DEFAULT 0 NOT NULL,
	`last_reply_at` integer,
	`edit_count` integer DEFAULT 0 NOT NULL,
	`last_edited_at` integer,
	`scheduled_at` integer,
	`share_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by` text,
	`delete_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forum_posts_share_code_unique` ON `forum_posts` (`share_code`);--> statement-breakpoint
CREATE INDEX `forum_posts_board_idx` ON `forum_posts` (`board_id`,`last_reply_at`);--> statement-breakpoint
CREATE INDEX `forum_posts_author_idx` ON `forum_posts` (`author_id`);--> statement-breakpoint
CREATE INDEX `forum_posts_status_idx` ON `forum_posts` (`status`);--> statement-breakpoint
CREATE INDEX `forum_posts_visibility_idx` ON `forum_posts` (`visibility`);--> statement-breakpoint
CREATE INDEX `forum_posts_created_idx` ON `forum_posts` (`created_at`);--> statement-breakpoint
CREATE TABLE `forum_reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forum_reactions_unique_idx` ON `forum_reactions` (`target_type`,`target_id`,`user_id`,`kind`);--> statement-breakpoint
CREATE INDEX `forum_reactions_target_idx` ON `forum_reactions` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `forum_replies` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`parent_id` text,
	`author_id` text NOT NULL,
	`content` text NOT NULL,
	`content_html` text NOT NULL,
	`floor` integer NOT NULL,
	`quoted_reply_id` text,
	`quoted_excerpt` text,
	`status` text DEFAULT 'published' NOT NULL,
	`collapsed` integer DEFAULT false NOT NULL,
	`collapse_reason` text,
	`accepted` integer DEFAULT false NOT NULL,
	`anonymous` integer DEFAULT false NOT NULL,
	`reaction_count` integer DEFAULT 0 NOT NULL,
	`edit_count` integer DEFAULT 0 NOT NULL,
	`last_edited_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by` text,
	`delete_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forum_replies_floor_idx` ON `forum_replies` (`post_id`,`floor`);--> statement-breakpoint
CREATE INDEX `forum_replies_post_idx` ON `forum_replies` (`post_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `forum_replies_author_idx` ON `forum_replies` (`author_id`);--> statement-breakpoint
CREATE TABLE `forum_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`color` text,
	`post_count` integer DEFAULT 0 NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forum_tags_name_unique` ON `forum_tags` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `forum_tags_slug_unique` ON `forum_tags` (`slug`);--> statement-breakpoint
CREATE INDEX `forum_tags_count_idx` ON `forum_tags` (`post_count`);--> statement-breakpoint
CREATE TABLE `forum_visibility_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`from_visibility` text,
	`to_visibility` text NOT NULL,
	`actor_id` text NOT NULL,
	`reason` text,
	`consent_snapshot` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `forum_visibility_audit_target_idx` ON `forum_visibility_audit` (`target_type`,`target_id`);