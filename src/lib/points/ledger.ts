import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { pointsLedger, users } from "@/lib/db/schema";

/**
 * 积分记账。
 *
 * 三条不可妥协的规则：
 *   1. **流水是唯一真值**，users.points 只是缓存列，可随时重算比对
 *   2. **只增不改**：写错了用反向流水冲正，绝不改原记录 ——
 *      改原记录会让「这个人为什么有 300 分」永远说不清
 *   3. **理由非空**：写不出理由的调整不该发生
 *
 * 幂等键让重试不会重复发放。定时任务失败重跑是常态，
 * 没有幂等键的话每重跑一次就多发一次分。
 */

export interface GrantInput {
  userId: string;
  delta: number;
  reason: string;
  ruleKey?: string;
  refType?: string;
  refId?: string;
  operatorId?: string;
  /** 同一个键只会记账一次 */
  idempotencyKey?: string;
}

export interface GrantResult {
  ok: boolean;
  /** 已经记过账时为 true，不算失败 */
  duplicate?: boolean;
  balance?: number;
  error?: string;
}

export function grantPoints(input: GrantInput): GrantResult {
  if (!input.reason.trim()) return { ok: false, error: "必须填写理由" };
  if (!Number.isInteger(input.delta) || input.delta === 0) {
    return { ok: false, error: "变动值必须是非零整数" };
  }

  if (input.idempotencyKey) {
    const seen = db
      .select()
      .from(pointsLedger)
      .where(eq(pointsLedger.idempotencyKey, input.idempotencyKey))
      .get();
    if (seen) return { ok: true, duplicate: true, balance: seen.balanceAfter };
  }

  try {
    return db.transaction((tx) => {
      const user = tx.select().from(users).where(eq(users.id, input.userId)).get();
      if (!user) return { ok: false, error: "用户不存在" };

      const balance = user.points + input.delta;
      // 扣分不能扣成负数 —— 余额为负会让所有基于余额的判断都失效
      if (balance < 0) return { ok: false, error: "积分不足" };

      tx.insert(pointsLedger)
        .values({
          userId: input.userId,
          delta: input.delta,
          balanceAfter: balance,
          ruleKey: input.ruleKey,
          reason: input.reason.trim(),
          refType: input.refType,
          refId: input.refId,
          operatorId: input.operatorId,
          idempotencyKey: input.idempotencyKey,
        })
        .run();

      tx.update(users)
        .set({
          points: balance,
          // 累计获得只增不减，用于等级计算：花掉的分不该让人掉级
          pointsTotal: input.delta > 0 ? user.pointsTotal + input.delta : user.pointsTotal,
          updatedAt: Date.now(),
        })
        .where(eq(users.id, input.userId))
        .run();

      return { ok: true, balance };
    });
  } catch (err) {
    // 幂等键的唯一约束可能在并发下才撞上
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      return { ok: true, duplicate: true };
    }
    throw err;
  }
}

/** 冲正。写一条反向流水，不动原记录 */
export function revertPoints(ledgerId: string, operatorId: string, reason: string): GrantResult {
  const original = db.select().from(pointsLedger).where(eq(pointsLedger.id, ledgerId)).get();
  if (!original) return { ok: false, error: "找不到这条流水" };
  if (original.revertedBy) return { ok: false, error: "这条流水已经冲正过了" };

  const result = grantPoints({
    userId: original.userId,
    delta: -original.delta,
    reason: `冲正：${reason}`,
    refType: original.refType ?? undefined,
    refId: original.refId ?? undefined,
    operatorId,
  });
  if (!result.ok) return result;

  const reversal = db
    .select()
    .from(pointsLedger)
    .where(eq(pointsLedger.userId, original.userId))
    .orderBy(desc(pointsLedger.createdAt))
    .get();

  if (reversal) {
    db.update(pointsLedger)
      .set({ revertsId: original.id })
      .where(eq(pointsLedger.id, reversal.id))
      .run();
    db.update(pointsLedger)
      .set({ revertedBy: reversal.id })
      .where(eq(pointsLedger.id, original.id))
      .run();
  }

  return result;
}

/** 用流水重算余额，和缓存列比对。不一致就是有 bug 或有人直接改了库 */
export function auditBalance(userId: string): {
  cached: number;
  computed: number;
  consistent: boolean;
} {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  const sum =
    db
      .select({ total: sql<number>`COALESCE(SUM(${pointsLedger.delta}), 0)` })
      .from(pointsLedger)
      .where(eq(pointsLedger.userId, userId))
      .get()?.total ?? 0;

  return {
    cached: user?.points ?? 0,
    computed: Number(sum),
    consistent: (user?.points ?? 0) === Number(sum),
  };
}

export function listLedger(userId: string, limit = 50) {
  return db
    .select()
    .from(pointsLedger)
    .where(eq(pointsLedger.userId, userId))
    .orderBy(desc(pointsLedger.createdAt))
    .limit(limit)
    .all();
}

/** 转移。悬赏采纳时用：一次事务里扣一边加一边，不会出现只扣不加 */
export function transferPoints(input: {
  fromUserId: string;
  toUserId: string;
  amount: number;
  reason: string;
  refType?: string;
  refId?: string;
  idempotencyKey?: string;
}): GrantResult {
  if (input.amount <= 0) return { ok: false, error: "金额必须为正" };
  if (input.fromUserId === input.toUserId) return { ok: false, error: "不能转给自己" };

  const deduct = grantPoints({
    userId: input.fromUserId,
    delta: -input.amount,
    reason: input.reason,
    refType: input.refType,
    refId: input.refId,
    idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:out` : undefined,
  });
  if (!deduct.ok) return deduct;
  // 已经转过了，别再加一次
  if (deduct.duplicate) return { ok: true, duplicate: true };

  const credit = grantPoints({
    userId: input.toUserId,
    delta: input.amount,
    reason: input.reason,
    refType: input.refType,
    refId: input.refId,
    idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:in` : undefined,
  });

  if (!credit.ok) {
    // 加分失败就把扣的退回去，绝不能只扣不加
    const ledgerRow = db
      .select()
      .from(pointsLedger)
      .where(
        and(
          eq(pointsLedger.userId, input.fromUserId),
          eq(pointsLedger.delta, -input.amount),
        ),
      )
      .orderBy(desc(pointsLedger.createdAt))
      .get();
    if (ledgerRow) revertPoints(ledgerRow.id, "system", "转账失败自动退回");
    return credit;
  }

  return { ok: true, balance: deduct.balance };
}
