import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 群发。
 *
 * 这是全站唯一会**主动向一千六百人发消息**的功能，
 * 也是唯一一个做错之后没法靠改数据库挽回的功能 ——
 * 消息已经在别人手机上响过了。
 *
 * 所以流程比其他任何功能都长：
 *   起草 → 冻结内容 → 另一个人复核 → 排队 → 逐群发送 → 逐群留痕
 *
 * 几条设计上的硬决定：
 *
 * ① **内容哈希在提交复核时冻结。** 复核的人看到什么，发出去的就必须是什么。
 *   不冻结的话，「先提一版温和的骗到批准，再改成别的」这条路是敞开的。
 *
 * ② **逐群一条记录。** 发了 12 个群，就有 12 条 delivery。
 *   汇总成一条的话，「有 3 个群没发出去」这件事永远没人知道。
 *
 * ③ **msg_svr_id 必须留下。** 它是撤回的唯一凭据。
 *   微信的撤回窗口很短，但「有机会撤」和「没机会」是天壤之别。
 */
export const broadcasts = sqliteTable(
  "broadcasts",
  {
    id: ulidPk(),
    /** 站内公告还是微信群发 —— 两者风险等级差一个数量级 */
    channel: text("channel", { enum: ["site", "wechat"] }).notNull(),

    title: text("title"),
    content: text("content").notNull(),
    /**
     * 提交复核时对 content 做的哈希。
     * 复核通过后再改内容，哈希对不上，发送会被拒。
     */
    contentHash: text("content_hash"),

    /** 站内公告的展示形式 */
    display: text("display", { enum: ["banner", "modal", "inbox"] }),
    /** 定向：留空表示全体 */
    targetRoleId: text("target_role_id"),
    /** 微信群发的目标会话，JSON 数组；留空表示所有已接入的群 */
    targetConvIds: text("target_conv_ids", { mode: "json" }),

    status: text("status", {
      enum: ["draft", "pending", "approved", "sending", "sent", "failed", "rejected", "canceled"],
    })
      .notNull()
      .default("draft"),

    createdBy: text("created_by").notNull(),
    submittedAt: integer("submitted_at"),
    /** 复核人。**必须与 createdBy 不同** */
    approvedBy: text("approved_by"),
    approvedAt: integer("approved_at"),
    approveNote: text("approve_note"),

    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    /** 成功与失败的群数 */
    sentCount: integer("sent_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    error: text("error"),

    /** 站内公告的有效期 */
    expiresAt: integer("expires_at"),

    createdAt: now("created_at"),
  },
  (t) => [
    index("broadcasts_status_idx").on(t.status, t.createdAt),
    index("broadcasts_channel_idx").on(t.channel, t.createdAt),
  ],
);

/** 逐群的投递结果。汇总成一条的话，没发出去的那几个群永远没人知道 */
export const broadcastDeliveries = sqliteTable(
  "broadcast_deliveries",
  {
    id: ulidPk(),
    broadcastId: text("broadcast_id").notNull(),
    convId: text("conv_id").notNull(),
    convName: text("conv_name"),

    status: text("status", { enum: ["pending", "sent", "failed", "revoked"] })
      .notNull()
      .default("pending"),
    /** 撤回的唯一凭据，拿不到就再也撤不回来 */
    msgSvrId: text("msg_svr_id"),
    error: text("error"),

    sentAt: integer("sent_at"),
    revokedAt: integer("revoked_at"),
    createdAt: now("created_at"),
  },
  (t) => [index("broadcast_deliveries_bid_idx").on(t.broadcastId)],
);
