import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { pointsLedger, users } from "@/lib/db/schema";

import { configuredLevels } from "./levels";
import { planRecount, type RecountPlan } from "./recount-rules";
import { levelOf } from "./rules";

/**
 * 按流水重算所有人的积分缓存。
 *
 * ─────────────────────────────────────────
 * 预览和执行走同一份计划
 * ─────────────────────────────────────────
 *
 * 两条计算路径的话，人确认的就不是真正会发生的事 ——
 * 而这个操作会改所有人的余额，那种偏差没有第二次机会。
 *
 * 所以 `buildPlan()` 只算不改，执行时把同一个 plan 传进来落库。
 */

export function buildPlan(): RecountPlan {
  const cached = db
    .select({
      userId: users.id,
      points: users.points,
      pointsTotal: users.pointsTotal,
      level: users.level,
    })
    .from(users)
    .all();

  /*
   * 一次 groupBy 算出每个人的两个和。
   *
   * `positiveSum` 用 CASE 而不是再查一遍 —— 累计获得是
   * 「只把正数加起来」，不是流水总和：花掉的分不该让人掉级。
   */
  const ledger = db
    .select({
      userId: pointsLedger.userId,
      sum: sql<number>`SUM(${pointsLedger.delta})`,
      positiveSum: sql<number>`SUM(CASE WHEN ${pointsLedger.delta} > 0 THEN ${pointsLedger.delta} ELSE 0 END)`,
    })
    .from(pointsLedger)
    .groupBy(pointsLedger.userId)
    .all()
    .map((r) => ({ userId: r.userId, sum: Number(r.sum), positiveSum: Number(r.positiveSum) }));

  const levels = configuredLevels();
  return planRecount(cached, ledger, (total) => levelOf(total, levels).level);
}

export interface RecountOutcome {
  updated: number;
}

/**
 * 落库。
 *
 * 一个事务 —— 中途失败会留下**一半重算过、一半没有**的库，
 * 而那种状态比一开始的不一致更难查：两边都「看起来对」。
 */
export function applyPlan(plan: RecountPlan): RecountOutcome {
  if (plan.rows.length === 0) return { updated: 0 };

  const now = Date.now();
  db.transaction((tx) => {
    for (const row of plan.rows) {
      tx.update(users)
        .set({
          points: row.points.to,
          pointsTotal: row.pointsTotal.to,
          level: row.level.to,
          updatedAt: now,
        })
        .where(eq(users.id, row.userId))
        .run();
    }
  });

  return { updated: plan.rows.length };
}
