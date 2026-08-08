import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 称号。
 *
 * 等级是**连续的**（攒分就会涨），称号是**离散的**（要么有要么没有）。
 * 两者缺一不可：等级回答「你来多久了」，称号回答「你是谁」。
 * 只有等级的社区里，所有人的区别只是数字大小，
 * 而「参与过内测」「第一个把某个群聊整理成帖」这种事没有地方安放。
 *
 * 称号也是**可持续回收口**：可租用的称号按期扣费，
 * 让积分回收和时间同步发生。一次性商品买完就没了，回收随之归零。
 */

export const TITLE_RARITIES = ["common", "rare", "epic", "legendary"] as const;
export type TitleRarity = (typeof TITLE_RARITIES)[number];

export const TITLE_SOURCES = ["grant", "achievement", "purchase", "seasonal"] as const;
export type TitleSource = (typeof TITLE_SOURCES)[number];

export const titles = sqliteTable(
  "titles",
  {
    id: ulidPk(),
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    /** emoji 就够了 —— 上传图标要配审核、存储和 CDN，不值当 */
    icon: text("icon"),
    color: text("color"),
    rarity: text("rarity", { enum: TITLE_RARITIES }).notNull().default("common"),
    source: text("source", { enum: TITLE_SOURCES }).notNull().default("grant"),

    /** 购买型的价格 */
    price: integer("price"),
    /**
     * 租期天数。非空表示到期失效，需要续费 ——
     * 这是积分的可持续回收口，不是为了折腾人
     */
    rentDays: integer("rent_days"),

    /** 成就型的达成条件 */
    conditionKind: text("condition_kind"),
    conditionValue: integer("condition_value"),

    /** 名额上限。稀有称号发滥了就不稀有了 */
    limitCount: integer("limit_count"),

    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    sort: integer("sort").notNull().default(0),

    createdBy: text("created_by"),
    createdAt: now("created_at"),
    updatedAt: now("updated_at"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("titles_sort_idx").on(t.sort), index("titles_source_idx").on(t.source)],
);

export const userTitles = sqliteTable(
  "user_titles",
  {
    id: ulidPk(),
    userId: text("user_id").notNull(),
    titleId: text("title_id").notNull(),

    source: text("source", { enum: TITLE_SOURCES }).notNull().default("grant"),
    grantedBy: text("granted_by"),
    grantReason: text("grant_reason"),
    /** 购买时实际花了多少 —— 事后调价不影响已购记录的对账 */
    pricePaid: integer("price_paid"),

    /** 租用/赛季称号的到期时间 */
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
    revokedBy: text("revoked_by"),
    revokeReason: text("revoke_reason"),

    createdAt: now("created_at"),
  },
  (t) => [
    index("user_titles_user_idx").on(t.userId, t.revokedAt),
    index("user_titles_title_idx").on(t.titleId, t.revokedAt),
    // 同一个称号不能重复持有；撤销后可以再授予，所以撤销时间进唯一键
    uniqueIndex("user_titles_unique_idx").on(t.userId, t.titleId, t.revokedAt),
  ],
);
