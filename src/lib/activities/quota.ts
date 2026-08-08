import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { activities, activityQuotaLog } from "@/lib/db/schema";

/**
 * 名额的占用与归还。
 *
 * ─────────────────────────────────────────
 * 60 个名额被 300 个人同时抢
 * ─────────────────────────────────────────
 *
 * 「先查再改」在这里必然出错：两个请求同时读到 `quota_used = 59`，
 * 都判断「还有」，然后都加一 —— 61 个人拿到了 60 个名额里的位置。
 *
 * 所以扣减必须是**一条带条件的 UPDATE**：
 *
 *     UPDATE activities SET quota_used = quota_used + 1
 *     WHERE id = ? AND quota_used < quota_total
 *
 * 影响行数为 0 就说明满了。条件和写入在同一条语句里，
 * 中间没有任何窗口。
 *
 * ─────────────────────────────────────────
 * quota_used 只是缓存列
 * ─────────────────────────────────────────
 *
 * 真值是 activity_quota_log 的累加。名额算错在限量活动里是致命事故 ——
 * 超卖意味着有人白高兴一场，少卖意味着名额白白浪费，
 * 两者都必须能事后查清是哪一笔出的问题。
 */

export interface ClaimResult {
  ok: boolean;
  /** 名额满了 —— 不是错误，是要转候补 */
  full?: boolean;
  balanceAfter?: number;
  error?: string;
}

export function claimQuota(input: {
  activityId: string;
  applicationId: string;
  reason: string;
  operatorId?: string;
}): ClaimResult {
  const activity = db.select().from(activities).where(eq(activities.id, input.activityId)).get();
  if (!activity) return { ok: false, error: "活动不存在" };

  // 不限名额时直接放行，但仍然记流水 —— 事后要能统计一共发了多少
  if (activity.quotaTotal === null) {
    const balance = activity.quotaUsed + 1;
    db.transaction((tx) => {
      tx.update(activities)
        .set({ quotaUsed: sql`${activities.quotaUsed} + 1` })
        .where(eq(activities.id, input.activityId))
        .run();
      tx.insert(activityQuotaLog)
        .values({
          activityId: input.activityId,
          delta: 1,
          balanceAfter: balance,
          reason: input.reason,
          applicationId: input.applicationId,
          operatorId: input.operatorId,
        })
        .run();
    });
    return { ok: true, balanceAfter: balance };
  }

  return db.transaction((tx) => {
    /*
     * 条件与写入在同一条语句里 —— 中间没有窗口。
     * 拆成「先 select 判断，再 update」的话，
     * 两个并发请求会同时判断「还有名额」然后都写进去。
     */
    const result = tx
      .update(activities)
      .set({ quotaUsed: sql`${activities.quotaUsed} + 1` })
      .where(
        sql`${activities.id} = ${input.activityId} AND ${activities.quotaUsed} < ${activities.quotaTotal}`,
      )
      .run();

    if (result.changes === 0) return { ok: true, full: true };

    const after = tx
      .select({ used: activities.quotaUsed })
      .from(activities)
      .where(eq(activities.id, input.activityId))
      .get()!;

    tx.insert(activityQuotaLog)
      .values({
        activityId: input.activityId,
        delta: 1,
        balanceAfter: after.used,
        reason: input.reason,
        applicationId: input.applicationId,
        operatorId: input.operatorId,
      })
      .run();

    return { ok: true, balanceAfter: after.used };
  });
}

/**
 * 归还一个名额。
 *
 * 撤回、判无效、履约失败都要还 —— 不还的话，
 * 一个填错的申请会永久占掉一个名额，而没人看得出来是为什么。
 */
export function releaseQuota(input: {
  activityId: string;
  applicationId: string;
  reason: string;
  operatorId?: string;
}): ClaimResult {
  return db.transaction((tx) => {
    // 不能扣成负数 —— 负的已用数会让「还剩几个」算出比总数还多
    const result = tx
      .update(activities)
      .set({ quotaUsed: sql`${activities.quotaUsed} - 1` })
      .where(sql`${activities.id} = ${input.activityId} AND ${activities.quotaUsed} > 0`)
      .run();

    if (result.changes === 0) return { ok: false, error: "没有可归还的名额" };

    const after = tx
      .select({ used: activities.quotaUsed })
      .from(activities)
      .where(eq(activities.id, input.activityId))
      .get()!;

    tx.insert(activityQuotaLog)
      .values({
        activityId: input.activityId,
        delta: -1,
        balanceAfter: after.used,
        reason: input.reason,
        applicationId: input.applicationId,
        operatorId: input.operatorId,
      })
      .run();

    return { ok: true, balanceAfter: after.used };
  });
}

export interface QuotaAudit {
  cached: number;
  computed: number;
  consistent: boolean;
  total: number | null;
  remaining: number | null;
}

/**
 * 用流水重算已用名额，和缓存列比对。
 *
 * 不一致就是有 bug 或有人直接改了库 —— 限量活动里这是致命的，
 * 所以后台要能随时查。
 */
export function auditQuota(activityId: string): QuotaAudit {
  const activity = db.select().from(activities).where(eq(activities.id, activityId)).get();
  const sum =
    db
      .select({ total: sql<number>`COALESCE(SUM(${activityQuotaLog.delta}), 0)` })
      .from(activityQuotaLog)
      .where(eq(activityQuotaLog.activityId, activityId))
      .get()?.total ?? 0;

  const cached = activity?.quotaUsed ?? 0;
  const computed = Number(sum);

  return {
    cached,
    computed,
    consistent: cached === computed,
    total: activity?.quotaTotal ?? null,
    remaining: activity?.quotaTotal === null || activity === undefined
      ? null
      : Math.max(0, activity.quotaTotal - cached),
  };
}
