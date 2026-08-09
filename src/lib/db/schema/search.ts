import { blob, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 会话窗口的向量。
 *
 * ─────────────────────────────────────────
 * 一段对话一行，不是一条消息一行
 * ─────────────────────────────────────────
 *
 * 数过：一半的群消息不超过 8 个字。「哈哈」「好的」单独嵌入
 * 得到的向量彼此都差不多，检索时既召不回想要的，
 * 又会把语气词排到前面 —— 做出来会像能用，实际每次都答非所问。
 *
 * 所以按「同群 + 相邻消息间隔 ≤5 分钟」切段，整段一起嵌入。
 * 30,339 条文本消息切成 3,506 段，1024 维 × 4 字节 = 14 MB，
 * 整份读进内存做余弦相似度毫无压力，不需要任何向量数据库。
 *
 * ─────────────────────────────────────────
 * conv_id 冗余存在这里，是为了权限
 * ─────────────────────────────────────────
 *
 * 检索必须**先按可见的群过滤，再算相似度** —— 和 FTS 那条路一样，
 * 收口在 SQL 层。搜索是最容易绕过权限的入口：
 * 只要能搜到只言片语，私密内容就已经泄露了。
 *
 * 存了 conv_id 才能在 SQL 里过滤；否则就得把全部向量读出来算完再筛，
 * 那时候「这个群里有没有人聊过某件事」已经从耗时上漏出去了。
 */
export const messageWindows = sqliteTable(
  "message_windows",
  {
    id: ulidPk(),
    /** (convId, 第一条消息 id) —— 重跑切段时靠它认出「这段已经嵌过了」 */
    windowKey: text("window_key").notNull(),
    convId: text("conv_id").notNull(),

    startTs: integer("start_ts").notNull(),
    endTs: integer("end_ts").notNull(),
    messageCount: integer("message_count").notNull(),
    /** JSON 数组：这一段包含哪些消息，命中后用来展开原文 */
    messageIds: text("message_ids").notNull(),
    /** 送去嵌入的那段文本，带说话人 */
    text: text("text").notNull(),

    /** Float32Array 的二进制。存 JSON 大四倍，而且每次都要重新解析 */
    vector: blob("vector", { mode: "buffer" }),
    /** 记下用哪个模型、多少维嵌的 —— 换模型之后要能认出哪些是旧的 */
    model: text("model"),
    dimensions: integer("dimensions"),
    embeddedAt: integer("embedded_at"),

    createdAt: now("created_at"),
  },
  (t) => [
    uniqueIndex("message_windows_key_idx").on(t.windowKey),
    // 检索时先按可见群过滤，这个索引是那一步的
    index("message_windows_conv_idx").on(t.convId, t.startTs),
    // 找「还没嵌过的」用
    index("message_windows_pending_idx").on(t.embeddedAt),
  ],
);
