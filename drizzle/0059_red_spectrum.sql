PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_github_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`github_user_id` text NOT NULL,
	`login` text NOT NULL,
	`name` text,
	`avatar_url` text,
	`html_url` text NOT NULL,
	`access_token` text,
	`scope` text DEFAULT '' NOT NULL,
	`show_on_profile` integer DEFAULT true NOT NULL,
	`pitch` text,
	`pitch_repo` text,
	`pitch_at` integer,
	`pinned_repos` text,
	`prompt_enabled` integer DEFAULT true NOT NULL,
	`connected_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
-- ⚠️ 这一句是**手改过的**，drizzle-kit 生成的原句会失败。
--
-- 它为了改 show_on_profile 的默认值而重建整张表，然后在 SELECT 里
-- 把三个**新加的**列（pitch / pitch_repo / pitch_at）也一起选了 ——
-- 而它们在旧表里根本不存在，于是 `no such column: "pitch"`。
--
-- 在生产库的副本上实测过：原句直接报错，整轮迁移中断，
-- 而迁移是跟着部署跑的。改成给新列填 NULL。
--
-- 教训：drizzle-kit 同时「改默认值」和「加列」时会生成这种句子，
-- 以后凡是生成了 __new_ 重建表的迁移，都要先在库的副本上跑一遍。
INSERT INTO `__new_github_connections`("id", "user_id", "github_user_id", "login", "name", "avatar_url", "html_url", "access_token", "scope", "show_on_profile", "pitch", "pitch_repo", "pitch_at", "pinned_repos", "prompt_enabled", "connected_at", "updated_at") SELECT "id", "user_id", "github_user_id", "login", "name", "avatar_url", "html_url", "access_token", "scope", "show_on_profile", NULL, NULL, NULL, "pinned_repos", "prompt_enabled", "connected_at", "updated_at" FROM `github_connections`;--> statement-breakpoint
DROP TABLE `github_connections`;--> statement-breakpoint
ALTER TABLE `__new_github_connections` RENAME TO `github_connections`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `github_connections_user_id_unique` ON `github_connections` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `github_connections_github_user_id_unique` ON `github_connections` (`github_user_id`);--> statement-breakpoint
CREATE INDEX `github_connections_login_idx` ON `github_connections` (`login`);