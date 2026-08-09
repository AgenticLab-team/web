import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 赛季。
 *
 * 它**只重置排名，不重置积分**。表里没有任何积分列 ——
 * 有的话就是又一个会和 points_ledger 对不上的冗余计数器。
 * 赛季榜是按日期范围现算 daily_stats 得到的。
 */
export const seasons = sqliteTable(
  "seasons",
  {
    id: ulidPk(),
    /** 2026Q3 这种 */
    key: text("key").notNull(),
    name: text("name").notNull(),

    /** 含 */
    startsAt: integer("starts_at").notNull(),
    /** 不含 —— 开区间省得纠结「最后一天算不算」 */
    endsAt: integer("ends_at").notNull(),

    /** 结算时间；null = 还没结算 */
    settledAt: integer("settled_at"),
    settleNote: text("settle_note"),

    createdAt: now("created_at"),
  },
  (t) => [
    uniqueIndex("seasons_key_idx").on(t.key),
    index("seasons_range_idx").on(t.startsAt, t.endsAt),
  ],
);

/**
 * 赛季结束时冻结的名次。
 *
 * 为什么要冻结：daily_stats 会被存储裁剪动到，
 * 而「2026 春季赛冠军是谁」这件事一旦发生就不该再变。
 * 现算的排名在裁剪之后会悄悄变成另一个人。
 */
export const seasonStandings = sqliteTable(
  "season_standings",
  {
    id: ulidPk(),
    seasonId: text("season_id").notNull(),
    wxId: text("wx_id").notNull(),

    rank: integer("rank").notNull(),
    quality: integer("quality").notNull().default(0),
    messages: integer("messages").notNull().default(0),
    chars: integer("chars").notNull().default(0),

    /** 发出去的称号 key；null = 这个名次没有称号 */
    awardedTitleKey: text("awarded_title_key"),

    createdAt: now("created_at"),
  },
  (t) => [
    uniqueIndex("season_standings_unique_idx").on(t.seasonId, t.wxId),
    index("season_standings_rank_idx").on(t.seasonId, t.rank),
  ],
);
