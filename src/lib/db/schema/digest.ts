import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 每周精选的生成记录。
 *
 * 存在的理由有两个：
 *   ① 同一周不重复生成（唯一索引挡住）
 *   ② 记下这一周选了哪几篇，下一周不再重复推同一篇
 *
 * 注意它记的是**生成**，不是发送 —— 发不发由人在群发页面按，
 * 那条记录在 broadcasts 里。这两件事分开记，
 * 是为了让「草稿备好了但没人发」这种情况看得出来。
 */
export const digestRuns = sqliteTable(
  "digest_runs",
  {
    id: ulidPk(),
    /**
     * 哪一种：`weekly`（每周精选）还是 `daily`（每天晚上那条）。
     *
     * ─────────────────────────────────────────
     * 两种共用一张表，是**故意的**
     * ─────────────────────────────────────────
     *
     * 这张表真正的价值不是「记录生成过什么」，是
     * 「**哪几篇已经推给群里了**」—— 而那件事只能有一份。
     *
     * 分两张表的话，周一早上周报推过的文章，周一晚上日报会再推一次。
     * 那是让人开始忽略这个消息的第一步，而且没有任何地方会报错。
     */
    kind: text("kind").notNull().default("weekly"),
    /** 周报是周一那天的 YYYY-MM-DD；日报是当天 */
    weekStart: text("week_start").notNull(),

    /** 入选的帖子 id，JSON 数组 */
    postIds: text("post_ids", { mode: "json" }).notNull(),
    itemCount: integer("item_count").notNull().default(0),

    /** 生成出来的群发草稿；null 表示这周判定为不该发 */
    broadcastId: text("broadcast_id"),
    /** 不生成时的原因 —— 「这周没有精选」要说得出为什么 */
    skipReason: text("skip_reason"),

    createdAt: now("created_at"),
  },
  (t) => [
    // 同一种、同一天只跑一次 —— 带上 kind，否则日报会被周报那行挡住
    uniqueIndex("digest_runs_kind_period_idx").on(t.kind, t.weekStart),
    index("digest_runs_created_idx").on(t.createdAt),
  ],
);
