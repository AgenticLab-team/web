import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 积分流水。**这是余额的唯一真值**，users.points 只是缓存列。
 *
 * 只增不改：写错了用反向流水冲正，绝不改原记录。
 * 改原记录会让「这个人为什么有 300 分」永远说不清 ——
 * 而积分一旦说不清，整个激励体系就失去公信力。
 */
export const pointsLedger = sqliteTable(
  "points_ledger",
  {
    id: ulidPk(),
    userId: text("user_id").notNull(),
    delta: integer("delta").notNull(),
    /** 记账后的余额，用于对账 */
    balanceAfter: integer("balance_after").notNull(),

    ruleKey: text("rule_key"),
    /** **非空是硬约束**：写不出理由的调整不该发生 */
    reason: text("reason").notNull(),

    refType: text("ref_type"),
    refId: text("ref_id"),
    /** 管理员手动调整时必填 */
    operatorId: text("operator_id"),

    /** 冲正关系：revertsId 指向被冲正的那条 */
    revertsId: text("reverts_id"),
    revertedBy: text("reverted_by"),

    /** 幂等键：重试不会重复发放 */
    idempotencyKey: text("idempotency_key"),

    createdAt: now("created_at"),
  },
  (t) => [
    index("points_ledger_user_idx").on(t.userId, t.createdAt),
    index("points_ledger_ref_idx").on(t.refType, t.refId),
    uniqueIndex("points_ledger_idempotency_idx").on(t.idempotencyKey),
  ],
);
