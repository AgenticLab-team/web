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
    /** 周一那天的 YYYY-MM-DD */
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
    uniqueIndex("digest_runs_week_idx").on(t.weekStart),
    index("digest_runs_created_idx").on(t.createdAt),
  ],
);
