/**
 * 积分重算（对账修复）。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 风控队列查得出来，但修不了
 * ─────────────────────────────────────────
 *
 * 上一轮做的风控队列会报「余额记着 999，流水加起来是 10」——
 * 而报完之后没有下一步。管理员唯一能做的是直接改库，
 * 而直接改库正是造成这种不一致的原因。
 *
 * `points.recount` 这个权限一直列在权限表里，零调用点。
 *
 * ─────────────────────────────────────────
 * 流水是唯一真值
 * ─────────────────────────────────────────
 *
 * `users.points` 只是缓存列（ledger.ts 顶上写着这条）。
 * 所以「重算」的方向只有一个：**按流水重写缓存**，
 * 绝不反过来去补一条流水把账做平 ——
 * 那是在伪造历史，而且伪造完之后再也查不出原来发生过什么。
 *
 * ─────────────────────────────────────────
 * 累计获得不能从流水直接加
 * ─────────────────────────────────────────
 *
 * `points_total` 是「只增不减」的口径：花掉的分不该让人掉级。
 * 所以它等于**所有正数流水之和**，而不是流水总和。
 * 直接用总和的话，花过分的人会掉级 —— 而这正是当初
 * 特意分出两个字段要避免的事。
 */

export interface LedgerFact {
  userId: string;
  /** 这个人所有流水的和 —— 应该等于余额 */
  sum: number;
  /** 只把正数加起来 —— 应该等于累计获得 */
  positiveSum: number;
}

export interface CachedFact {
  userId: string;
  points: number;
  pointsTotal: number;
  level: number;
}

export interface RecountRow {
  userId: string;
  points: { from: number; to: number };
  pointsTotal: { from: number; to: number };
  level: { from: number; to: number };
}

export interface RecountPlan {
  /** 需要改的那些 */
  rows: RecountRow[];
  /** 扫了多少个账号 */
  scanned: number;
  /** 余额会变的人数 —— 这是最要紧的一个数 */
  balanceChanges: number;
  /** 等级会变的人数 */
  levelChanges: number;
  /** 净增减多少分。不为 0 说明之前有人直接改过库 */
  netDelta: number;
}

/**
 * 算出这次重算会改什么。
 *
 * **只算不改** —— 调用方拿这个去出预览，确认之后再执行同一份计划。
 * 预览和执行走两条不同的计算路径的话，人确认的就不是真正会发生的事。
 */
export function planRecount(
  cached: CachedFact[],
  ledger: LedgerFact[],
  levelOf: (pointsTotal: number) => number,
): RecountPlan {
  const byUser = new Map(ledger.map((l) => [l.userId, l]));
  const rows: RecountRow[] = [];

  let balanceChanges = 0;
  let levelChanges = 0;
  let netDelta = 0;

  for (const user of cached) {
    const facts = byUser.get(user.userId) ?? { userId: user.userId, sum: 0, positiveSum: 0 };

    const points = facts.sum;
    const pointsTotal = facts.positiveSum;
    const level = levelOf(pointsTotal);

    if (points === user.points && pointsTotal === user.pointsTotal && level === user.level) {
      continue;
    }

    if (points !== user.points) {
      balanceChanges++;
      netDelta += points - user.points;
    }
    if (level !== user.level) levelChanges++;

    rows.push({
      userId: user.userId,
      points: { from: user.points, to: points },
      pointsTotal: { from: user.pointsTotal, to: pointsTotal },
      level: { from: user.level, to: level },
    });
  }

  return { rows, scanned: cached.length, balanceChanges, levelChanges, netDelta };
}

/**
 * 这次重算要不要拦一下。
 *
 * ─────────────────────────────────────────
 * 改动太大时先问一句
 * ─────────────────────────────────────────
 *
 * 正常情况下重算只该动几个人 —— 那是某次直接改库留下的痕迹。
 * 如果它要动**一半以上的账号**，更可能的解释是流水本身出了问题
 * （比如某次迁移漏抄了一批），而这时候按流水重写缓存会
 * **把所有人的分抹掉**。
 *
 * 这一条不是禁止，是要求人看一眼再点。
 */
export const WIDE_IMPACT_RATIO = 0.5;

export function isWideImpact(plan: RecountPlan): boolean {
  if (plan.scanned === 0) return false;
  return plan.balanceChanges / plan.scanned > WIDE_IMPACT_RATIO;
}

/** 预览那句话 —— 空的时候要说「对得上」，不是「暂无数据」 */
export function describePlan(plan: RecountPlan): string {
  if (plan.rows.length === 0) {
    return `${plan.scanned} 个账号全部对得上，不需要重算`;
  }
  const parts = [`${plan.rows.length} 个账号要改`];
  if (plan.balanceChanges > 0) {
    parts.push(`其中 ${plan.balanceChanges} 个余额会变（净 ${plan.netDelta > 0 ? "+" : ""}${plan.netDelta} 分）`);
  }
  if (plan.levelChanges > 0) parts.push(`${plan.levelChanges} 个等级会变`);
  return parts.join("，");
}
