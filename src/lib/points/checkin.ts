import "server-only";

import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  checkins,
  dailyStats,
  messages,
  pointsAnomalies,
  pointsLedger,
  posts,
  reactions,
  replies,
  users,
} from "@/lib/db/schema";
import type { CurrentUser } from "@/lib/auth/session";
import { visibleGroupIds } from "@/lib/queries/visibility";
import { getSettingBool, getSettingInt } from "@/lib/settings/store";
import { endOfDayMs, shiftDateKey, startOfDayMs, todayKey } from "@/lib/time";

import { settleInviteReward } from "@/lib/invites/settle";

import { INTERACTION_WEIGHTS } from "./economy";
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
    checkinMinForum: getSettingInt("points.checkin.min_forum_units", 3),
    checkinBase: getSettingInt("points.checkin.base", 10),
    qualityBonusPer: getSettingInt("points.quality_bonus.per", 5),
    qualityBonusStep: getSettingInt("points.quality_bonus.step", 5),
    qualityBonusDailyCap: getSettingInt("points.quality_bonus.daily_cap", 20),
    streakCap: getSettingInt("points.streak.cap", 30),

    // 发行侧的闸门，见 economy.ts 开头那段说明
    dailyMintCap: getSettingInt("points.economy.daily_mint_cap", 60),
    interactionFullUnits: getSettingInt("points.interaction.full_units", 10),
    interactionDecayRatio: getSettingInt("points.interaction.decay_percent", 50) / 100,
    interactionPointsPerUnit: getSettingInt("points.interaction.points_per_unit", 1),
    interactionCap: getSettingInt("points.interaction.daily_cap", 20),
    transferFeeRatio: getSettingInt("points.transfer.fee_percent", 5) / 100,
    inflationWarnRatio: getSettingInt("points.economy.inflation_warn_percent", 8) / 100,
  };
}

/**
 * 今天已经发给这个人多少分。
 *
 * 每日发行上限是**所有来源共享**的，所以这里统计的是当天全部入账，
 * 不只是打卡那一笔。只算打卡的话，加一个新玩法就等于开一个新口子。
 */
export function mintedToday(userId: string, date: string): number {
  const row = db
    .select({ n: sql<number>`coalesce(sum(${pointsLedger.delta}), 0)` })
    .from(pointsLedger)
    .where(
      and(
        eq(pointsLedger.userId, userId),
        sql`${pointsLedger.delta} > 0`,
        gte(pointsLedger.createdAt, startOfDayMs(date)),
        lt(pointsLedger.createdAt, endOfDayMs(date)),
      ),
    )
    .get();
  return Number(row?.n ?? 0);
}

/**
 * 今天的论坛活跃度与互动明细。
 *
 * 论坛这条路是给「主要在论坛写长文」的人留的 ——
 * 只认群聊的话，沉淀内容最多的那批人反而打不了卡。
 */
export function forumActivityToday(userId: string, date: string) {
  const from = startOfDayMs(date);
  const to = endOfDayMs(date);

  const postCount = Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(posts)
      .where(
        and(
          eq(posts.authorId, userId),
          isNull(posts.deletedAt),
          gte(posts.createdAt, from),
          lt(posts.createdAt, to),
        ),
      )
      .get()?.n ?? 0,
  );

  const replyCount = Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(replies)
      .where(
        and(
          eq(replies.authorId, userId),
          isNull(replies.deletedAt),
          gte(replies.createdAt, from),
          lt(replies.createdAt, to),
        ),
      )
      .get()?.n ?? 0,
  );

  const reactionsGiven = Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(reactions)
      .where(
        and(
          eq(reactions.userId, userId),
          gte(reactions.createdAt, from),
          lt(reactions.createdAt, to),
        ),
      )
      .get()?.n ?? 0,
  );

  // 收到的赞要按「今天被赞」算，不是「今天发的内容收到的赞」——
  // 后者会让老帖子的赞永远算不进来
  const reactionsReceived = Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(reactions)
      .innerJoin(posts, eq(posts.id, reactions.targetId))
      .where(
        and(
          eq(reactions.targetType, "post"),
          eq(posts.authorId, userId),
          gte(reactions.createdAt, from),
          lt(reactions.createdAt, to),
        ),
      )
      .get()?.n ?? 0,
  );

  const units =
    postCount * INTERACTION_WEIGHTS.post + replyCount * INTERACTION_WEIGHTS.reply;

  return { postCount, replyCount, reactionsGiven, reactionsReceived, units };
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
  forum: ReturnType<typeof forumActivityToday>;
  streak: number;
  /** 今天还剩多少发行额度，界面上要让人看得见 */
  budgetRemaining: number;
  budgetCap: number;
}

export function checkinStatus(user: CurrentUser): CheckinStatus {
  const config = loadPointsConfig();
  const today = todayKey();
  const groupIds = visibleGroupIds(user);
  const quality = user.wxId ? qualityToday(user.wxId, groupIds, today) : { raw: 0, counted: 0 };
  const forum = forumActivityToday(user.id, today);
  const minted = mintedToday(user.id, today);

  const verdict = evaluateCheckin(
    {
      qualityToday: quality.counted,
      forumUnitsToday: forum.units,
      interactions: {
        post: forum.postCount,
        reply: forum.replyCount,
        reactionGiven: forum.reactionsGiven,
        reactionReceived: forum.reactionsReceived,
        qualityMessage: quality.counted,
      },
      mintedToday: minted,
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
    forum,
    streak: user.streakCurrent,
    budgetRemaining: Math.max(0, config.dailyMintCap - minted),
    budgetCap: config.dailyMintCap,
  };
}

export interface CheckinResult {
  ok: boolean;
  error?: string;
  awarded?: number;
  streak?: number;
  /** 因为撞每日发行上限，这次一分没拿到 */
  cappedOut?: boolean;
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
  const { base, qualityBonus, streakBonus, interactionBonus, total, capped, streakAfter } =
    status.verdict;
  const levelBefore = levelOf(user.pointsTotal).level;

  /*
   * 撞上每日发行上限时 total 会是 0。
   * 这时候记一笔 0 分的流水没有意义，但**绝不能当成失败** ——
   * 打卡本身要算数，连胜不能因为「今天分发满了」就断掉。
   * 断一次连胜比少给几分伤人得多。
   */
  if (total > 0) {
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
  }

  db.transaction((tx) => {
    tx.insert(checkins)
      .values({
        userId: user.id,
        date: today,
        pointsAwarded: total,
        basePoints: base,
        qualityBonus,
        streakBonus,
        interactionBonus,
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

  /*
   * 邀请奖励在这里结算，不是在注册时。
   * 注册即给的话，拉一堆僵尸号就能刷分 —— 而打卡本身要求
   * 群里发言或论坛活跃达标，也就是说只有真的参与了社区的人
   * 才会让邀请人拿到奖励。这条门槛是复用现成的反作弊，不是新造一套。
   */
  settleInviteReward(user.id);

  const levelAfter = levelOf(user.pointsTotal + total).level;

  return {
    ok: true,
    awarded: total,
    cappedOut: capped && total === 0,
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
