import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 申请加入社群。
 *
 * ─────────────────────────────────────────
 * 这张表是陌生人写的
 * ─────────────────────────────────────────
 *
 * 站里别的东西都要先登录、而登录要先是群成员。这张表不行 ——
 * 想加入的人按定义还不是成员。所以它是全站唯一一个
 * **未认证的人能往里写**的地方。
 *
 * 因此：
 *   · 存 IP，用来限流（这是唯一的垃圾投放面）
 *   · 内容一律当成不可信的展示数据，只给管理员看
 *   · **不做唯一约束**。同一个微信号重复提交要能存下来 ——
 *     用唯一约束去重的话，第二次提交会失败，而失败信息
 *     等于告诉提交者「这个号已经申请过了」，那就成了一个查询接口
 */
export const joinRequests = sqliteTable(
  "join_requests",
  {
    id: ulidPk(),
    /** 提交者自称的微信号。不校验格式 —— 管理员核对时本来就要人工看 */
    wxId: text("wx_id").notNull(),
    reason: text("reason").notNull(),
    contact: text("contact"),

    /** 限流用；也是唯一能追溯到「谁在灌」的线索 */
    ip: text("ip"),
    userAgent: text("user_agent"),

    status: text("status", { enum: ["pending", "handled", "rejected"] })
      .notNull()
      .default("pending"),
    handledBy: text("handled_by"),
    handledAt: integer("handled_at"),
    /** 管理员的处理备注，申请人看不到 */
    note: text("note"),

    createdAt: now("created_at"),
  },
  (t) => [
    index("join_requests_status_idx").on(t.status, t.createdAt),
    index("join_requests_ip_idx").on(t.ip, t.createdAt),
    index("join_requests_wx_idx").on(t.wxId),
  ],
);
