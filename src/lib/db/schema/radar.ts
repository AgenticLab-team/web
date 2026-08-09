import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 关键词订阅。
 *
 * 只在**订阅者自己所在的群**里匹配 —— 否则这就不是雷达，
 * 是一个可以监听任意群的工具。
 */
export const keywordSubs = sqliteTable(
  "keyword_subs",
  {
    id: ulidPk(),
    userId: text("user_id").notNull(),

    /** 用户写下来的样子 */
    keyword: text("keyword").notNull(),
    /** 匹配用的键（小写、空白归一） */
    keywordKey: text("keyword_key").notNull(),

    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),

    /** 订阅时算出来的七天命中数，用来解释「为什么这么吵」 */
    hits7dAtCreate: integer("hits_7d_at_create").notNull().default(0),

    /** 今天已经提醒过几次；跨天由 isNewDay 重置 */
    hitsToday: integer("hits_today").notNull().default(0),
    lastNotifiedAt: integer("last_notified_at"),
    /** 累计命中（含被封顶压掉的）—— 让人看得出「其实响了很多次」 */
    totalHits: integer("total_hits").notNull().default(0),

    createdAt: now("created_at"),
  },
  (t) => [
    // 同一个人不能订阅两个同义的词
    uniqueIndex("keyword_subs_user_key_idx").on(t.userId, t.keywordKey),
    index("keyword_subs_enabled_idx").on(t.enabled),
  ],
);

/** 命中记录。用来做「最近命中」列表与对账 */
export const keywordHits = sqliteTable(
  "keyword_hits",
  {
    id: ulidPk(),
    subId: text("sub_id").notNull(),
    messageId: text("message_id").notNull(),
    convId: text("conv_id").notNull(),
    senderName: text("sender_name"),
    snippet: text("snippet"),
    /** 这一条有没有真的发出通知（被日封顶压掉的记 false） */
    notified: integer("notified", { mode: "boolean" }).notNull().default(false),
    hitAt: integer("hit_at").notNull(),
  },
  (t) => [
    // 同一条消息对同一个订阅只记一次 —— 重跑同步不该让计数翻倍
    uniqueIndex("keyword_hits_sub_msg_idx").on(t.subId, t.messageId),
    index("keyword_hits_sub_idx").on(t.subId, t.hitAt),
  ],
);
