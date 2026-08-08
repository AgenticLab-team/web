import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";
import { VISIBILITY_LEVELS } from "./forum";

/**
 * 可见性提升申请。
 *
 * 群聊转帖默认锁死在原群范围（硬约束 2）。想让更多人看到，
 * 只能走这条队列 —— 这是那条硬约束**唯一的出口**，
 * 所以它自己必须是最严的一段流程：
 *
 *   1. 上限是「仅成员」，**永远到不了公开**。这不是配置，是硬约束 1，
 *      改不动 —— 群里说的话不该出现在搜索引擎里。
 *   2. 需要**原作者同意**。群里那几个人只是在群里聊天，
 *      没同意过被拿给一千六百人看。
 *   3. 需要**另一个人**审核。转帖人自己批自己的申请，
 *      整条约束就形同虚设。
 */
export const visibilityRequests = sqliteTable(
  "visibility_requests",
  {
    id: ulidPk(),
    postId: text("post_id").notNull(),
    requestedBy: text("requested_by").notNull(),

    fromVisibility: text("from_visibility", { enum: VISIBILITY_LEVELS }).notNull(),
    toVisibility: text("to_visibility", { enum: VISIBILITY_LEVELS }).notNull(),
    /** 申请人为什么觉得值得公开 —— 审核的人要靠它判断 */
    reason: text("reason").notNull(),

    status: text("status", { enum: ["pending", "approved", "rejected", "withdrawn"] })
      .notNull()
      .default("pending"),

    /** 需要征得同意的原作者数量，以及已同意的数量 */
    consentRequired: integer("consent_required").notNull().default(0),
    consentGranted: integer("consent_granted").notNull().default(0),

    reviewedBy: text("reviewed_by"),
    reviewedAt: integer("reviewed_at"),
    reviewNote: text("review_note"),

    createdAt: now("created_at"),
  },
  (t) => [
    index("visibility_requests_status_idx").on(t.status, t.createdAt),
    index("visibility_requests_post_idx").on(t.postId),
  ],
);
