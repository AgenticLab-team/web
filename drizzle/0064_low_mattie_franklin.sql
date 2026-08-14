CREATE TABLE `mail_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime` text,
	`size` integer DEFAULT 0 NOT NULL,
	`stored` integer DEFAULT false NOT NULL,
	`path` text,
	`expires_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mail_attachments_message_idx` ON `mail_attachments` (`message_id`);--> statement-breakpoint
CREATE TABLE `mail_banwords` (
	`id` text PRIMARY KEY NOT NULL,
	`word` text NOT NULL,
	`kind` text DEFAULT 'exact' NOT NULL,
	`reason` text,
	`builtin` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_banwords_word_idx` ON `mail_banwords` (`word`,`kind`);--> statement-breakpoint
CREATE TABLE `mail_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`target` text,
	`match_kind` text NOT NULL,
	`pattern` text NOT NULL,
	`reason` text,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mail_blocks_scope_idx` ON `mail_blocks` (`scope`,`target`);--> statement-breakpoint
CREATE TABLE `mail_boxes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`local_part` text NOT NULL,
	`domain` text NOT NULL,
	`address` text NOT NULL,
	`kind` text NOT NULL,
	`label` text,
	`muted` integer DEFAULT false NOT NULL,
	`custom` integer DEFAULT false NOT NULL,
	`expires_at` integer,
	`grace_until` integer,
	`renewed_at` integer,
	`renew_count` integer DEFAULT 0 NOT NULL,
	`slot_id` text,
	`order_id` text,
	`token_id` text,
	`quota_bytes` integer,
	`used_bytes` integer DEFAULT 0 NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`unread_count` integer DEFAULT 0 NOT NULL,
	`last_received_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_boxes_address_idx` ON `mail_boxes` (`address`) WHERE "mail_boxes"."status" NOT IN ('expired','revoked');--> statement-breakpoint
CREATE INDEX `mail_boxes_user_idx` ON `mail_boxes` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `mail_boxes_domain_idx` ON `mail_boxes` (`domain`);--> statement-breakpoint
CREATE INDEX `mail_boxes_expiry_idx` ON `mail_boxes` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `mail_boxes_token_idx` ON `mail_boxes` (`token_id`);--> statement-breakpoint
CREATE TABLE `mail_domains` (
	`domain` text PRIMARY KEY NOT NULL,
	`punycode` text NOT NULL,
	`kind` text NOT NULL,
	`tier` text,
	`owner_user_id` text,
	`source_application_id` text,
	`allow_burner` integer DEFAULT false NOT NULL,
	`allow_claim` integer DEFAULT false NOT NULL,
	`allow_custom_local` integer DEFAULT true NOT NULL,
	`in_random_rotation` integer DEFAULT false NOT NULL,
	`catch_all` integer DEFAULT false NOT NULL,
	`registrar` text,
	`registered_at` integer,
	`domain_expires_at` integer,
	`expiry_notice_stage` integer,
	`mx_ok` integer,
	`spf_ok` integer,
	`dmarc_ok` integer,
	`dns_checked_at` integer,
	`dns_detail` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`note` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mail_domains_kind_idx` ON `mail_domains` (`kind`,`enabled`);--> statement-breakpoint
CREATE INDEX `mail_domains_owner_idx` ON `mail_domains` (`owner_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mail_domains_punycode_idx` ON `mail_domains` (`punycode`);--> statement-breakpoint
CREATE INDEX `mail_domains_expiry_idx` ON `mail_domains` (`domain_expires_at`);--> statement-breakpoint
CREATE TABLE `mail_events` (
	`id` text PRIMARY KEY NOT NULL,
	`box_id` text,
	`domain` text,
	`event` text NOT NULL,
	`actor_id` text,
	`actor_kind` text DEFAULT 'system' NOT NULL,
	`token_id` text,
	`detail` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mail_events_box_idx` ON `mail_events` (`box_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `mail_events_domain_idx` ON `mail_events` (`domain`,`created_at`);--> statement-breakpoint
CREATE TABLE `mail_ingress_log` (
	`id` text PRIMARY KEY NOT NULL,
	`envelope_from` text,
	`envelope_to` text NOT NULL,
	`matched_box_id` text,
	`verdict` text NOT NULL,
	`reason` text,
	`size` integer DEFAULT 0 NOT NULL,
	`source_ip` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mail_ingress_to_idx` ON `mail_ingress_log` (`envelope_to`,`created_at`);--> statement-breakpoint
CREATE INDEX `mail_ingress_verdict_idx` ON `mail_ingress_log` (`verdict`,`created_at`);--> statement-breakpoint
CREATE TABLE `mail_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`box_id` text NOT NULL,
	`rfc_message_id` text,
	`in_reply_to` text,
	`envelope_from` text,
	`from_addr` text,
	`from_name` text,
	`to_addr` text NOT NULL,
	`subject` text,
	`body_text` text,
	`body_html_path` text,
	`size` integer DEFAULT 0 NOT NULL,
	`has_attachments` integer DEFAULT false NOT NULL,
	`attachment_meta` text,
	`spam_score` integer,
	`spf_pass` integer,
	`dkim_pass` integer,
	`dmarc_pass` integer,
	`otp_code` text,
	`received_at` integer NOT NULL,
	`read_at` integer,
	`expires_at` integer,
	`purged_at` integer
);
--> statement-breakpoint
CREATE INDEX `mail_messages_box_idx` ON `mail_messages` (`box_id`,`received_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `mail_messages_dedupe_idx` ON `mail_messages` (`box_id`,`rfc_message_id`);--> statement-breakpoint
CREATE INDEX `mail_messages_expiry_idx` ON `mail_messages` (`expires_at`);--> statement-breakpoint
CREATE TABLE `mail_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`order_id` text,
	`ledger_id` text,
	`granted_by` text,
	`grant_reason` text,
	`revoked_at` integer,
	`revoked_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mail_slots_user_idx` ON `mail_slots` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `device_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_code_hash` text NOT NULL,
	`device_code_hash` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`device_label` text NOT NULL,
	`request_ip` text,
	`scopes` text NOT NULL,
	`ssh_key_fingerprint` text,
	`approved_by_user_id` text,
	`approved_at` integer,
	`wrong_code_tries` integer DEFAULT 0 NOT NULL,
	`last_polled_at` integer,
	`poll_interval` integer DEFAULT 5 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_user_code_idx` ON `device_codes` (`user_code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_device_code_idx` ON `device_codes` (`device_code_hash`);--> statement-breakpoint
CREATE INDEX `device_codes_expires_idx` ON `device_codes` (`expires_at`);--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `device_label` text;