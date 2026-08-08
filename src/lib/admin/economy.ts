import "server-only";

import { and, desc, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { pointsLedger, users } from "@/lib/db/schema";
import { loadPointsConfig } from "@/lib/points/checkin";
import { concentration, inflationReport, type InflationReport } from "@/lib/points/economy";

/**
 * 积分经济看板。
 *
 * 通胀是**测出来的，不是感觉出来的**。没有这块看板，
 * 「积分是不是发多了」只能靠拍脑袋，而等到能凭感觉察觉的时候，
 * 存量已经大到收不回来了 —— 积分只能发不能收，
 * 唯一能调的是**未来的发行速度**，所以必须早看见。
 */

export interface EconomySnapshot {
  /** 当前流通总量（所有人余额之和） */
  circulating: number;
  /** 累计发行总量 */
  lifetimeMinted: number;
  holders: number;
  /** 窗口内的体检结论 */
  inflation: InflationReport;
  /** 分配集中度 */
  distribution: ReturnType<typeof concentration>;
  /** 发行来源分布 */
  sources: { key: string; label: string; amount: number; share: number }[];
  /** 回收去向分布 */
  sinks: { key: string; label: string; amount: number; share: number }[];
  /** 每日发行/回收趋势 */
  daily: { date: string; minted: number; burned: number }[];
  windowDays: number;
}

const RULE_LABELS: Record<string, string> = {
  checkin: "每日打卡",
  quality: "高质量发言",
  interaction: "互动结算",
  admin: "管理员调整",
  transfer: "转赠",
  shop: "商店消费",
  title: "称号",
  activity: "活动",
};

function labelFor(key: string | null): string {
  if (!key) return "其他";
  return RULE_LABELS[key] ?? key;
}

export function economySnapshot(windowDays = 30): EconomySnapshot {
  const since = Date.now() - windowDays * 86_400_000;

  const circulating = Number(
    db.select({ n: sql<number>`coalesce(sum(${users.points}), 0)` }).from(users).get()?.n ?? 0,
  );
  const lifetimeMinted = Number(
    db.select({ n: sql<number>`coalesce(sum(${users.pointsTotal}), 0)` }).from(users).get()?.n ?? 0,
  );
  const holders = Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(sql`${users.points} > 0`)
      .get()?.n ?? 0,
  );

  const minted = Number(
    db
      .select({ n: sql<number>`coalesce(sum(${pointsLedger.delta}), 0)` })
      .from(pointsLedger)
      .where(and(gte(pointsLedger.createdAt, since), sql`${pointsLedger.delta} > 0`))
      .get()?.n ?? 0,
  );
  const burned = Math.abs(
    Number(
      db
        .select({ n: sql<number>`coalesce(sum(${pointsLedger.delta}), 0)` })
        .from(pointsLedger)
        .where(and(gte(pointsLedger.createdAt, since), sql`${pointsLedger.delta} < 0`))
        .get()?.n ?? 0,
    ),
  );

  const config = loadPointsConfig();

  /*
   * 期初流通量 = 现在的流通量 - 窗口内的净增。
   * 直接拿现在的流通量当分母会**系统性低估**通胀率 ——
   * 分母里已经含了这段时间新发的量。
   */
  const circulatingBefore = Math.max(0, circulating - (minted - burned));

  const bySource = db
    .select({
      key: pointsLedger.ruleKey,
      amount: sql<number>`coalesce(sum(${pointsLedger.delta}), 0)`,
    })
    .from(pointsLedger)
    .where(and(gte(pointsLedger.createdAt, since), sql`${pointsLedger.delta} > 0`))
    .groupBy(pointsLedger.ruleKey)
    .all();

  const bySink = db
    .select({
      key: pointsLedger.ruleKey,
      amount: sql<number>`coalesce(sum(${pointsLedger.delta}), 0)`,
    })
    .from(pointsLedger)
    .where(and(gte(pointsLedger.createdAt, since), sql`${pointsLedger.delta} < 0`))
    .groupBy(pointsLedger.ruleKey)
    .all();

  const daily = db
    .select({
      date: sql<string>`date(${pointsLedger.createdAt} / 1000, 'unixepoch', '+8 hours')`,
      minted: sql<number>`coalesce(sum(case when ${pointsLedger.delta} > 0 then ${pointsLedger.delta} else 0 end), 0)`,
      burned: sql<number>`coalesce(sum(case when ${pointsLedger.delta} < 0 then -${pointsLedger.delta} else 0 end), 0)`,
    })
    .from(pointsLedger)
    .where(gte(pointsLedger.createdAt, since))
    .groupBy(sql`1`)
    .orderBy(sql`1`)
    .all();

  const balances = db
    .select({ n: users.points })
    .from(users)
    .where(sql`${users.points} > 0`)
    .all()
    .map((r) => r.n);

  return {
    circulating,
    lifetimeMinted,
    holders,
    inflation: inflationReport({ minted, burned, circulatingBefore }, config),
    distribution: concentration(balances),
    sources: share(bySource.map((r) => ({ key: r.key, amount: Number(r.amount) }))),
    sinks: share(bySink.map((r) => ({ key: r.key, amount: Math.abs(Number(r.amount)) }))),
    daily: daily.map((r) => ({
      date: r.date,
      minted: Number(r.minted),
      burned: Number(r.burned),
    })),
    windowDays,
  };
}

function share(rows: { key: string | null; amount: number }[]) {
  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  return rows
    .map((r) => ({
      key: r.key ?? "other",
      label: labelFor(r.key),
      amount: r.amount,
      share: total > 0 ? r.amount / total : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
}

/** 发行最多的几个人 —— 异常刷分先在这里露头 */
export function topEarners(windowDays = 30, limit = 10) {
  const since = Date.now() - windowDays * 86_400_000;
  return db
    .select({
      userId: pointsLedger.userId,
      name: users.siteNickname,
      wxName: users.wxNickname,
      wxId: users.wxId,
      earned: sql<number>`coalesce(sum(${pointsLedger.delta}), 0)`,
    })
    .from(pointsLedger)
    .leftJoin(users, eq(users.id, pointsLedger.userId))
    .where(and(gte(pointsLedger.createdAt, since), sql`${pointsLedger.delta} > 0`))
    .groupBy(pointsLedger.userId)
    .orderBy(desc(sql`3`))
    .limit(limit)
    .all()
    .map((r) => ({ ...r, earned: Number(r.earned) }));
}

/** 今天各人的发行量，用来看每日上限是不是设得太松或太紧 */
export function dailyCapPressure(date: string): {
  atCap: number;
  nearCap: number;
  active: number;
  cap: number;
} {
  const config = loadPointsConfig();
  const from = new Date(`${date}T00:00:00+08:00`).getTime();
  const to = from + 86_400_000;

  const rows = db
    .select({
      userId: pointsLedger.userId,
      minted: sql<number>`coalesce(sum(${pointsLedger.delta}), 0)`,
    })
    .from(pointsLedger)
    .where(
      and(
        gte(pointsLedger.createdAt, from),
        lt(pointsLedger.createdAt, to),
        sql`${pointsLedger.delta} > 0`,
      ),
    )
    .groupBy(pointsLedger.userId)
    .all()
    .map((r) => Number(r.minted));

  return {
    // 撞顶的人太多说明上限压得太死，太少说明上限形同虚设
    atCap: rows.filter((n) => n >= config.dailyMintCap).length,
    nearCap: rows.filter((n) => n >= config.dailyMintCap * 0.8).length,
    active: rows.length,
    cap: config.dailyMintCap,
  };
}
