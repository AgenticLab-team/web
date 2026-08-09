CREATE TABLE `makeup_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`order_id` text,
	`used_for_date` text,
	`used_at` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `makeup_cards_user_idx` ON `makeup_cards` (`user_id`,`used_at`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`user_id` text NOT NULL,
	`price_paid` integer NOT NULL,
	`ledger_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`shipping` text,
	`tracking_no` text,
	`fulfill_result` text,
	`note` text,
	`handled_by` text,
	`handled_at` integer,
	`refund_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `orders_user_idx` ON `orders` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `orders_item_idx` ON `orders` (`item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_ledger_idx` ON `orders` (`ledger_id`);--> statement-breakpoint
CREATE TABLE `shop_items` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`icon` text,
	`price` integer NOT NULL,
	`stock` integer,
	`sold` integer DEFAULT 0 NOT NULL,
	`per_user_limit` integer,
	`config` text,
	`enabled` integer DEFAULT false NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_items_key_unique` ON `shop_items` (`key`);--> statement-breakpoint
CREATE INDEX `shop_items_enabled_idx` ON `shop_items` (`enabled`,`sort`);