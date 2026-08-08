import "server-only";

import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { checkins, dailyStats, messages, pointsAnomalies, users } from "@/lib/db/schema";
import type { CurrentUser } from "@/lib/auth/session";
import { visibleGroupIds } from "@/lib/queries/visibility";
import { getSettingBool, getSettingInt } from "@/lib/settings/store";
import { endOfDayMs, shiftDateKey, startOfDayMs, todayKey } from "@/lib/time";

import { grantPoints } from "./ledger";
import {
  collapseByMinute,
  dedupeSimilar,
  detectAnomaly,
  evaluateCheckin,
  levelOf,
  type CheckinVerdict,
  type PointsConfig,
} from "./rules";

/**
 * 打卡的数据库侧。
 *
 * 判定逻辑全在 rules.ts 里（纯函数、已被测试覆盖），
 * 这里只负责把输入查齐、把结果落库。
 *
 * 计分用的是**过完反作弊的数量**，不是原始计数 ——
 * 直接用原始计数的话，连着刷十条「这个不错」就能拿满加分。
 */

export function loadPointsConfig(): PointsConfig {
  return {
    checkinMinQuality: getSettingInt("points.checkin.min_quality_messages", 3),
    checkinBase: getSettingInt("points.checkin.base", 10),
    qualityBonusPer: getSettingInt("points.quality_bonus.per", 5),
    qualityBonusStep: getSettingInt("points.quality_bonus.step", 5),
    qualityBonusDailyCap: getSettingInt("points.quality_bonus.daily_cap", 20),
    streakCap: getSettingInt("points.streak.cap", 30),
  };
}

export interface QualityToday {
  /** 原始条数 */
  raw: number;
  /** 过完反作弊之后的条数 */
  counted: number;
}

/**
 * 统计某人今天的高质量发言，并应用反作弊。
 *
 * 只统计**这个人所在的群** —— 与可见性收口保持一致，
 * 否则会出现「统计里算了他，但他自己在网站上看不到那条」的怪事。
 */
export function qualityToday(wxId: string, groupIds: string[], date: string): QualityToday {
  if (groupIds.length === 0) return { raw: 0, counted: 0 };

  const rows = db
    .select({ content: messages.content, ts: messages.ts })
    .from(messages)
    .where(
      and(
        eq(messages.senderWxId, wxId),
        eq(messages.isQuality, true),
        eq(messages.isSend, false),
        inArray(messages.convId, groupIds),
        gte(messages.ts, startOfDayMs(date)),
        lt(messages.ts, endOfDayMs(date)),
      ),
    )
    .all();

  const raw = rows.length;
  if (raw === 0) return { raw: 0, counted: 0 };

  let counted = raw;
  if (getSettingBool("antifraud.same_minute_collapse", true)) {
    counted = Math.min(counted, collapseByMinute(rows.map((r) => r.ts)));
  }
  if (getSettingBool("antifraud.dedupe_similar", true)) {
    counted = Math.min(counted, dedupeSimilar(rows.map((r) => r.content)));
  }

  return { raw, counted };
}

export interface CheckinStatus {
  canCheckin: boolean;
  checkedToday: boolean;
  verdict: CheckinVerdict;
  quality: QualityToday;
  streak: number;
}

export function checkinStatus(user: CurrentUser): CheckinStatus {
  const config = loadPointsConfig();
  const today = todayKey();
  const groupIds = visibleGroupIds(user);
  const quality = user.wxId ? qualityToday(user.wxId, groupIds, today) : { raw: 0, counted: 0 };

  const verdict = evaluateCheckin(
    {
      qualityToday: quality.counted,
      streakBefore: user.streakCurrent,
      lastCheckinDate: user.lastCheckinDate,
      today,
      yesterday: shiftDateKey(today, -1),
    },
    config,
  );

  return {
    canCheckin: verdict.ok,
    checkedToday: user.lastCheckinDate === today,
    verdict,
    quality,
    streak: user.streakCurrent,
  };
}

export interface CheckinResult {
  ok: boolean;
  error?: string;
  awarded?: number;
  streak?: number;
  leveledUp?: { from: number; to: number } | null;
}

/**
 * 执行打卡。
 *
 * 幂等键用「用户 + 日期」—— 重复点击、并发请求、
 * 定时任务重跑都只会记一次账。
 */
export function performCheckin(user: CurrentUser, ip?: string): CheckinResult {
  const status = checkinStatus(user);
  if (!status.verdict.ok) {
    return { ok: false, error: status.verdict.message };
  }

  const today = todayKey();
  const { base, qualityBonus, streakBonus, total, streakAfter } = status.verdict;
  const levelBefore = levelOf(user.pointsTotal).level;

  const granted = grantPoints({
    userId: user.id,
    delta: total,
    reason: `每日打卡（连胜 ${streakAfter} 天）`,
    ruleKey: "checkin",
    refType: "checkin",
    refId: `${user.id}:${today}`,
    idempotencyKey: `checkin:${user.id}:${today}`,
  });

  if (!granted.ok) return { ok: false, error: granted.error };
  // 已经打过了（并发或重试），不再重复写记录
  if (granted.duplicate) return { ok: false, error: "今天已经打过卡了" };

  db.transaction((tx) => {
    tx.insert(checkins)
      .values({
        userId: user.id,
        date: today,
        pointsAwarded: total,
        basePoints: base,
        qualityBonus,
        streakBonus,
        qualityRaw: status.quality.raw,
        qualityCounted: status.quality.counted,
        streakAfter,
        ip,
      })
      .onConflictDoNothing()
      .run();

    tx.update(users)
      .set({
        lastCheckinDate: today,
        streakCurrent: streakAfter,
        streakBest: sql`MAX(${users.streakBest}, ${streakAfter})`,
        level: levelOf(user.pointsTotal + total).level,
        updatedAt: Date.now(),
      })
      .where(eq(users.id, user.id))
      .run();
  });

  flagAnomalyIfNeeded(user, status.quality.counted);

  const levelAfter = levelOf(user.pointsTotal + total).level;

  return {
    ok: true,
    awarded: total,
    streak: streakAfter,
    leveledUp: levelAfter > levelBefore ? { from: levelBefore, to: levelAfter } : null,
  };
}

/**
 * 异常增长进人工复核队列，不自动扣分。
 * 自动惩罚误伤一次，那个人就再也不敢在群里多说话了。
 */
function flagAnomalyIfNeeded(user: CurrentUser, todayCounted: number) {
  if (!user.wxId) return;

  const today = todayKey();
  const recent = db
    .select({ date: dailyStats.date, quality: sql<number>`sum(${dailyStats.qualityMessages})` })
    .from(dailyStats)
    .where(
      and(
        eq(dailyStats.wxId, user.wxId),
        sql`${dailyStats.date} >= ${shiftDateKey(today, -14)}`,
        sql`${dailyStats.date} < ${today}`,
      ),
    )
    .groupBy(dailyStats.date)
    .all();

  const result = detectAnomaly({
    todayQuality: todayCounted,
    recentDaily: recent.map((r) => Number(r.quality)),
    spikeThreshold: getSettingInt("antifraud.spike_threshold", 3),
  });
  if (!result.anomalous) return;

  const existing = db
    .select()
    .from(pointsAnomalies)
    .where(and(eq(pointsAnomalies.userId, user.id), eq(pointsAnomalies.status, "open")))
    .get();
  if (existing) return;

  db.insert(pointsAnomalies)
    .values({
      userId: user.id,
      kind: "spike",
      score: Math.round(result.ratio * 100),
      detail: { todayCounted, ratio: result.ratio, samples: recent.length },
    })
    .run();
}

/** 最近的打卡记录，用于日历与个人页 */
export function recentCheckins(userId: string, days = 90) {
  const from = shiftDateKey(todayKey(), -(days - 1));
  return db
    .select()
    .from(checkins)
    .where(and(eq(checkins.userId, userId), gte(checkins.date, from)))
    .orderBy(desc(checkins.date))
    .all();
}
