import "server-only";

import { and, eq, gte, isNull, sql } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { checkins, makeupCards, users } from "@/lib/db/schema";
import { getSettingInt } from "@/lib/settings/store";
import { dateKey, todayKey } from "@/lib/time";
import {
  MAKEUP_WINDOW_DAYS,
  checkMakeup,
  makeupCandidates,
  shiftDate,
  streakFrom,
  type MakeupCandidate,
  type MakeupVerdict,
} from "@/lib/points/makeup-rules";

/**
 * 用一张补签卡把断掉的那天补回来。
 *
 * 为什么补签不发分、为什么只能补最近几天、为什么连胜要重算而不是加一 ——
 * 全在 `makeup-rules.ts` 顶上。
 */

export interface MakeupState {
  cards: number;
  candidates: MakeupCandidate[];
  usedThisMonth: number;
  monthlyLimit: number;
  /** 现在的连胜（从记录算出来的，不是读缓存列） */
  streak: number;
}

/** 窗口内打过卡的日子。多取一天 —— 算连胜要看窗口再往前那一天接不接得上 */
function checkedDatesIn(userId: string, today: string): string[] {
  const from = shiftDate(today, -(MAKEUP_WINDOW_DAYS + 60));
  return db
    .select({ date: checkins.date })
    .from(checkins)
    .where(and(eq(checkins.userId, userId), gte(checkins.date, from)))
    .all()
    .map((r) => r.date);
}

function unusedCards(userId: string): number {
  return db
    .select({ n: sql<number>`count(*)` })
    .from(makeupCards)
    .where(and(eq(makeupCards.userId, userId), isNull(makeupCards.usedAt)))
    .get()?.n ?? 0;
}

/** 这个自然月补过几次。按 used_at 落在本月算 */
function usedThisMonth(userId: string, today: string): number {
  const monthPrefix = today.slice(0, 7);
  return db
    .select({ n: sql<number>`count(*)` })
    .from(checkins)
    .where(
      and(
        eq(checkins.userId, userId),
        eq(checkins.isMakeup, true),
        sql`substr(${checkins.date}, 1, 7) = ${monthPrefix}`,
      ),
    )
    .get()?.n ?? 0;
}

export function makeupState(user: CurrentUser, today = todayKey()): MakeupState {
  const checked = checkedDatesIn(user.id, today);
  /*
   * 注册那天之前不许补。
   *
   * 没有这一条，一个刚注册的人买三十张卡就能凭空得到一条三十天的连胜 ——
   * 而榜单和等级都认它。
   */
  const since = user.createdAt ? dateKey(user.createdAt) : null;

  return {
    cards: unusedCards(user.id),
    candidates: makeupCandidates({ today, checkedDates: checked, since }),
    usedThisMonth: usedThisMonth(user.id, today),
    monthlyLimit: getSettingInt("points.makeup_card.monthly_limit", 1),
    streak: streakFrom(checked, today),
  };
}

export type MakeupResult =
  | { ok: true; date: string; streak: number; cardsLeft: number }
  | { ok: false; error: string };

/*
 * 名字不能以 `use` 开头 —— React 的 hooks 规则会把 `useXxx` 当成 Hook，
 * 于是在一个普通函数里调用它就成了「在非组件里调用 Hook」的 lint 错误。
 * 这个坑只在把它接进 Server Action 那一刻才暴露出来。
 */
export function redeemMakeupCard(user: CurrentUser, date: string, today = todayKey()): MakeupResult {
  const checked = checkedDatesIn(user.id, today);
  const since = user.createdAt ? dateKey(user.createdAt) : null;

  const verdict: MakeupVerdict = checkMakeup({
    date,
    today,
    checkedDates: checked,
    since,
    cards: unusedCards(user.id),
    usedThisMonth: usedThisMonth(user.id, today),
    monthlyLimit: getSettingInt("points.makeup_card.monthly_limit", 1),
  });
  if (!verdict.ok) return { ok: false, error: verdict.message };

  const cost = getSettingInt("points.makeup_card.cost", 200);

  /*
   * 一个事务里做三件事：标掉卡、插打卡行、重算连胜。
   *
   * 分开做的话，中间失败会留下「卡用掉了但没补上」或者
   * 「补上了但卡还在」—— 前者是用户直接损失，后者是一张永动的卡。
   */
  let streakAfter = 0;
  try {
    db.transaction((tx) => {
      /*
       * 先占卡，用**带条件的 UPDATE** 而不是「先查再改」。
       *
       * 两个标签页同时点的话，「先查再改」两边都会查到「还有一张」，
       * 然后各补一天 —— 而只扣掉一张。条件写在同一句里，
       * 第二次的 changes 是 0，那一次就退出去了。
       */
      const card = tx
        .select({ id: makeupCards.id })
        .from(makeupCards)
        .where(and(eq(makeupCards.userId, user.id), isNull(makeupCards.usedAt)))
        .limit(1)
        .get();
      if (!card) throw new Error("no_card");

      const claimed = tx
        .update(makeupCards)
        .set({ usedAt: Date.now(), usedForDate: date })
        .where(and(eq(makeupCards.id, card.id), isNull(makeupCards.usedAt)))
        .run();
      if (claimed.changes === 0) throw new Error("no_card");

      /*
       * 补签这一行**不发分**（`pointsAwarded: 0`）。
       * 卡是用积分买的，补签再把分发回来就成了洗分的路子。
       * 人买它想要的是连胜，不是那几分。
       *
       * `makeupCost` 记下当时的卡价 —— 事后对账时，
       * 「这条连胜是花多少买来的」是个要答得上来的问题。
       */
      tx.insert(checkins)
        .values({
          userId: user.id,
          date,
          pointsAwarded: 0,
          basePoints: 0,
          streakAfter: 0, // 下面重算完再回填
          isMakeup: true,
          makeupCost: cost,
        })
        .run();

      // 连胜从记录重算，不给缓存列打补丁 —— 见 makeup-rules.ts
      const after = streakFrom([...checked, date], today);
      streakAfter = after;

      tx.update(checkins)
        .set({ streakAfter: after })
        .where(and(eq(checkins.userId, user.id), eq(checkins.date, date)))
        .run();

      tx.update(users)
        .set({
          streakCurrent: after,
          streakBest: sql`MAX(${users.streakBest}, ${after})`,
        })
        .where(eq(users.id, user.id))
        .run();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "no_card") return { ok: false, error: "你没有补签卡了" };
    // 同一天被补两次会撞唯一索引 —— 说人话，不要把约束名甩出去
    if (/UNIQUE/i.test(message)) return { ok: false, error: "这天已经打过卡了" };
    return { ok: false, error: "补签没成功，再试一次" };
  }

  return { ok: true, date, streak: streakAfter, cardsLeft: unusedCards(user.id) };
}
