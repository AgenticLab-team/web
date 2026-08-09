import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 「我导出了我自己的数据」的记录。
 *
 * ─────────────────────────────────────────
 * 一张表同时干两件事
 * ─────────────────────────────────────────
 *
 * **留痕**：谁在什么时候导走了什么、多少条。一份 zip 一旦落到本地，
 * 站内的可见性就再也管不着它了 —— 这张表是事后唯一能回答
 * 「这份数据是从哪来的」的记录。记条数不记内容：把导出的正文
 * 再抄进日志一遍，等于为了留痕又造了一份同样敏感的副本。
 *
 * **限流**：判定直接数这张表里最近的行（和 login_attempts 同一个路子），
 * 不额外维护一个内存计数器 —— 内存计数器会在每次重启后清零，
 * 而重启恰恰是被人刷接口刷到崩之后必然发生的事。
 *
 * 行是在**开始导出之前**插的，status 先记 started。
 * 跑到一半崩掉的那一次照样占一个配额 —— 它确实消耗了机器的时间，
 * 不该因为失败就白送一次重试。
 */
export const dataExports = sqliteTable(
  "data_exports",
  {
    id: ulidPk(),
    userId: text("user_id").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),

    /** 这次导出带不带别人的发言。是这份文件里最要紧的一个性质 */
    withContext: integer("with_context", { mode: "boolean" }).notNull().default(true),

    status: text("status", { enum: ["started", "completed", "failed"] })
      .notNull()
      .default("started"),

    ownMessages: integer("own_messages").notNull().default(0),
    contextMessages: integer("context_messages").notNull().default(0),
    windows: integer("windows").notNull().default(0),
    posts: integer("posts").notNull().default(0),
    replies: integer("replies").notNull().default(0),
    drafts: integer("drafts").notNull().default(0),
    interactions: integer("interactions").notNull().default(0),
    /** 撞到条数上限被截断了 */
    truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
    bytes: integer("bytes").notNull().default(0),

    error: text("error"),
    startedAt: now("started_at"),
    finishedAt: integer("finished_at"),
  },
  // 限流每次都按 (user_id, started_at) 查最近几条，没有这个索引就是全表扫
  (t) => [index("data_exports_user_idx").on(t.userId, t.startedAt)],
);
