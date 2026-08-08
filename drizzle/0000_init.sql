CREATE TABLE `bind_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`user_id` text,
	`session_nonce` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`matched_channel` text,
	`matched_wx_id` text,
	`matched_conv_id` text,
	`matched_source` text,
	`matched_at` integer,
	`issued_ip` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE INDEX `bind_codes_code_idx` ON `bind_codes` (`code`,`status`);--> statement-breakpoint
CREATE INDEX `bind_codes_expires_idx` ON `bind_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text,
	`credential_id` text,
	`secret` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`backed_up` integer DEFAULT false NOT NULL,
	`last_used_at` integer,
	`last_used_ip` text,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	`revoked_by` text,
	`revoke_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_credential_id_unique` ON `credentials` (`credential_id`);--> statement-breakpoint
CREATE INDEX `credentials_user_idx` ON `credentials` (`user_id`,`type`);--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`identifier` text,
	`method` text NOT NULL,
	`success` integer NOT NULL,
	`failure_reason` text,
	`ip` text,
	`user_agent` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_attempts_ip_idx` ON `login_attempts` (`ip`,`created_at`);--> statement-breakpoint
CREATE INDEX `login_attempts_user_idx` ON `login_attempts` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`device_name` text,
	`ip` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`revoked_by` text,
	`revoke_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `user_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`display_name` text,
	`avatar_url` text,
	`raw` text,
	`linked_at` integer NOT NULL,
	`unlinked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_provider_external_idx` ON `user_identities` (`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `user_identities_user_idx` ON `user_identities` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`author_id` text NOT NULL,
	`content` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `user_notes_user_idx` ON `user_notes` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_privacy` (
	`user_id` text PRIMARY KEY NOT NULL,
	`hide_from_directory` integer DEFAULT false NOT NULL,
	`hide_from_leaderboard` integer DEFAULT false NOT NULL,
	`hide_activity_hours` integer DEFAULT false NOT NULL,
	`searchable_by_others` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`wx_id` text,
	`wx_nickname` text,
	`wx_avatar_url` text,
	`site_nickname` text,
	`bio` text,
	`email` text,
	`email_verified_at` integer,
	`kind` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`level` integer DEFAULT 1 NOT NULL,
	`points` integer DEFAULT 0 NOT NULL,
	`points_total` integer DEFAULT 0 NOT NULL,
	`streak_current` integer DEFAULT 0 NOT NULL,
	`streak_best` integer DEFAULT 0 NOT NULL,
	`last_checkin_date` text,
	`invited_by` text,
	`first_bound_at` integer,
	`last_active_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by` text,
	`delete_reason` text,
	`meta` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_wx_id_unique` ON `users` (`wx_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_status_idx` ON `users` (`status`);--> statement-breakpoint
CREATE INDEX `users_kind_idx` ON `users` (`kind`);--> statement-breakpoint
CREATE INDEX `users_points_idx` ON `users` (`points`);--> statement-breakpoint
CREATE INDEX `users_last_active_idx` ON `users` (`last_active_at`);--> statement-breakpoint
CREATE TABLE `permission_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`permission_key` text NOT NULL,
	`granted` integer NOT NULL,
	`scope_type` text,
	`scope_id` text,
	`reason` text NOT NULL,
	`granted_by` text NOT NULL,
	`granted_at` integer NOT NULL,
	`expires_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `permission_overrides_user_idx` ON `permission_overrides` (`user_id`);--> statement-breakpoint
CREATE TABLE `permissions` (
	`key` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`label` text NOT NULL,
	`description` text,
	`scopable` integer DEFAULT false NOT NULL,
	`danger_level` integer DEFAULT 0 NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_id` text NOT NULL,
	`permission_key` text NOT NULL,
	`granted` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_permissions_pk` ON `role_permissions` (`role_id`,`permission_key`);--> statement-breakpoint
CREATE TABLE `role_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`taken_at` integer NOT NULL,
	`taken_by` text,
	`note` text,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`color` text,
	`icon` text,
	`badge_style` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`assignable` integer DEFAULT true NOT NULL,
	`max_holders` integer,
	`auto_grant_rule` text,
	`auto_revoke` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_key_unique` ON `roles` (`key`);--> statement-breakpoint
CREATE INDEX `roles_priority_idx` ON `roles` (`priority`);--> statement-breakpoint
CREATE TABLE `user_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	`scope_type` text,
	`scope_id` text,
	`granted_by` text,
	`granted_at` integer NOT NULL,
	`grant_reason` text,
	`expires_at` integer,
	`revoked_at` integer,
	`revoked_by` text,
	`revoke_reason` text
);
--> statement-breakpoint
CREATE INDEX `user_roles_user_idx` ON `user_roles` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_roles_role_idx` ON `user_roles` (`role_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_roles_unique_idx` ON `user_roles` (`user_id`,`role_id`,`scope_type`,`scope_id`);--> statement-breakpoint
CREATE TABLE `daily_stats` (
	`wx_id` text NOT NULL,
	`conv_id` text NOT NULL,
	`date` text NOT NULL,
	`messages` integer DEFAULT 0 NOT NULL,
	`quality_messages` integer DEFAULT 0 NOT NULL,
	`chars_total` integer DEFAULT 0 NOT NULL,
	`first_msg_at` integer,
	`last_msg_at` integer,
	`hour_histogram` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_stats_pk` ON `daily_stats` (`wx_id`,`conv_id`,`date`);--> statement-breakpoint
CREATE INDEX `daily_stats_date_idx` ON `daily_stats` (`date`);--> statement-breakpoint
CREATE INDEX `daily_stats_wx_date_idx` ON `daily_stats` (`wx_id`,`date`);--> statement-breakpoint
CREATE TABLE `group_member_events` (
	`id` text PRIMARY KEY NOT NULL,
	`conv_id` text NOT NULL,
	`wx_id` text NOT NULL,
	`event` text NOT NULL,
	`detail` text,
	`detected_at` integer NOT NULL,
	`processed_at` integer
);
--> statement-breakpoint
CREATE INDEX `gme_conv_idx` ON `group_member_events` (`conv_id`,`detected_at`);--> statement-breakpoint
CREATE INDEX `gme_unprocessed_idx` ON `group_member_events` (`processed_at`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`conv_id` text NOT NULL,
	`wx_id` text NOT NULL,
	`display_name` text,
	`messages` integer DEFAULT 0 NOT NULL,
	`joined_at` integer,
	`left_at` integer,
	`is_admin` integer DEFAULT false NOT NULL,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_members_pk` ON `group_members` (`conv_id`,`wx_id`);--> statement-breakpoint
CREATE INDEX `group_members_wx_idx` ON `group_members` (`wx_id`);--> statement-breakpoint
CREATE TABLE `groups` (
	`conv_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`avatar_url` text,
	`is_group` integer DEFAULT true NOT NULL,
	`bound` integer DEFAULT false NOT NULL,
	`sync_enabled` integer DEFAULT false NOT NULL,
	`quality_min` integer,
	`count_for_points` integer DEFAULT true NOT NULL,
	`public_leaderboard` integer DEFAULT false NOT NULL,
	`retention_days` integer,
	`description` text,
	`notice` text,
	`member_count` integer DEFAULT 0 NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`last_message_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE INDEX `groups_sync_idx` ON `groups` (`sync_enabled`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conv_id` text NOT NULL,
	`sender_wx_id` text NOT NULL,
	`sender_name` text,
	`is_send` integer DEFAULT false NOT NULL,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`length` integer DEFAULT 0 NOT NULL,
	`is_quality` integer DEFAULT false NOT NULL,
	`has_media` integer DEFAULT false NOT NULL,
	`ts` integer NOT NULL,
	`tier` text DEFAULT 'hot' NOT NULL,
	`indexed` integer DEFAULT false NOT NULL,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_conv_ts_idx` ON `messages` (`conv_id`,`ts`);--> statement-breakpoint
CREATE INDEX `messages_sender_ts_idx` ON `messages` (`sender_wx_id`,`ts`);--> statement-breakpoint
CREATE INDEX `messages_ts_idx` ON `messages` (`ts`);--> statement-breakpoint
CREATE INDEX `messages_tier_idx` ON `messages` (`tier`);--> statement-breakpoint
CREATE TABLE `sync_cursors` (
	`kind` text NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`last_ts` integer DEFAULT 0 NOT NULL,
	`last_id` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_cursors_pk` ON `sync_cursors` (`kind`,`scope`);--> statement-breakpoint
CREATE TABLE `sync_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`scope` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`duration_ms` integer,
	`items_fetched` integer DEFAULT 0 NOT NULL,
	`items_written` integer DEFAULT 0 NOT NULL,
	`error` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`triggered_by` text DEFAULT 'cron' NOT NULL,
	`triggered_by_user` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sync_jobs_kind_idx` ON `sync_jobs` (`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `admin_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`params` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`preview` text,
	`result` text,
	`error` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `admin_tasks_status_idx` ON `admin_tasks` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `api_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`status_code` integer,
	`latency_ms` integer,
	`triggered_by` text,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `api_usage_created_idx` ON `api_usage` (`created_at`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`payload` text NOT NULL,
	`danger_level` integer DEFAULT 3 NOT NULL,
	`requested_by` text NOT NULL,
	`requested_at` integer NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`approve_note` text,
	`executed_at` integer,
	`execute_result` text,
	`expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `approvals_status_idx` ON `approvals` (`status`,`requested_at`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`actor_role` text,
	`actor_ip` text,
	`actor_ua` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`target_label` text,
	`before` text,
	`after` text,
	`reason` text,
	`danger_level` integer DEFAULT 0 NOT NULL,
	`approval_id` text,
	`request_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_logs_actor_idx` ON `audit_logs` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_action_idx` ON `audit_logs` (`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_target_idx` ON `audit_logs` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `audit_logs_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `feature_flags` (
	`key` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`rollout` text DEFAULT 'all' NOT NULL,
	`rollout_value` text,
	`description` text,
	`updated_at` integer NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `setting_history` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`changed_by` text,
	`reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `setting_history_key_idx` ON `setting_history` (`key`,`created_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`type` text DEFAULT 'string' NOT NULL,
	`category` text DEFAULT 'general' NOT NULL,
	`label` text,
	`description` text,
	`default_value` text,
	`min_value` integer,
	`max_value` integer,
	`requires_permission` text,
	`updated_at` integer NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `storage_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`taken_at` integer NOT NULL,
	`db_bytes` integer DEFAULT 0 NOT NULL,
	`fts_bytes` integer DEFAULT 0 NOT NULL,
	`media_cache_bytes` integer DEFAULT 0 NOT NULL,
	`thumb_bytes` integer DEFAULT 0 NOT NULL,
	`disk_total` integer DEFAULT 0 NOT NULL,
	`disk_used` integer DEFAULT 0 NOT NULL,
	`disk_pct` integer DEFAULT 0 NOT NULL,
	`by_table` text
);
--> statement-breakpoint
CREATE TABLE `system_health` (
	`id` text PRIMARY KEY NOT NULL,
	`component` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`latency_ms` integer,
	`checked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `system_health_component_idx` ON `system_health` (`component`,`checked_at`);