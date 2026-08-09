import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { seasonStandings, seasons, titles, userTitles, users } from "@/lib/db/schema";
import { notify } from "@/lib/forum/notify";
import { allSyncedGroupIds } from "@/lib/queries/visibility";
import { seasonBoard, pendingSettlement, type SeasonRow } from "@/lib/seasons/queries";
import {
  planAwards,
  rankLabel,
  seasonTitleExpiry,
  type Season,
} from "@/lib/seasons/rules";

/**
 * 赛季结算。
 *
 * ─────────────────────────────────────────
 * 它一个字都不碰余额
 * ─────────────────────────────────────────
 *
 * 赛季只重置**排名**。清一次积分就等于告诉所有人「你攒的东西
 * 随时可能没有」，而那之后没有人会再把它当回事 ——
 * ECONOMY.md 里那三条致命项之一就是这个。
 *
 * 所以结算只做两件事：把名次**冻结**下来，给前三发称号。
 * 冻结是必要的：daily_stats 会被存储裁剪动到，
 * 而「2026 春季赛冠军是谁」一旦发生就不该再变 ——
 * 现算的排名在裁剪之后会悄悄换成另一个人。
 *
 * ─────────────────────────────────────────
 * 结算用**全站范围**，不是某个人看得到的群
 * ─────────────────────────────────────────
 *
 * 榜单展示按可见性过滤，那是给人看的；
 * 而「谁是这个赛季的冠军」只能有一个答案，不能因为看的人不同而不同。
 */

export interface SettleSeasonResult {
  seasonKey: string;
  ok: boolean;
  reason: string;
  frozen: number;
  awarded: number;
}

export function settleSeason(row: SeasonRow, now = Date.now()): SettleSeasonResult {
  if (row.settledAt !== null) {
    return {
      seasonKey: row.key,
      ok: false,
      reason: "这个赛季已经结算过了",
      frozen: 0,
      awarded: 0,
    };
  }
  if (now < row.endsAt) {
    return { seasonKey: row.key, ok: false, reason: "赛季还没结束", frozen: 0, awarded: 0 };
  }

  // 全站范围 —— 冠军只能有一个答案
  const standings = seasonBoard(row, allSyncedGroupIds(), 200);
  const plan = planAwards(standings);

  const season: Season = {
    key: row.key,
    name: row.name,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
  };
  const expiresAt = seasonTitleExpiry(season);
  const awardByWxId = new Map(plan.awards.map((a) => [a.wxId, a]));

  db.transaction(() => {
    for (const standing of standings) {
      const award = awardByWxId.get(standing.wxId);
      db.insert(seasonStandings)
        .values({
          seasonId: row.id,
          wxId: standing.wxId,
          rank: standing.rank,
          quality: standing.quality,
          messages: standing.messages,
          chars: standing.chars,
          awardedTitleKey: award?.titleKey ?? null,
        })
        .onConflictDoNothing()
        .run();
    }

    db.update(seasons)
      .set({ settledAt: now, settleNote: plan.reason })
      .where(eq(seasons.id, row.id))
      .run();
  });

  let awarded = 0;
  for (const award of plan.awards) {
    if (grantSeasonTitle(award.wxId, award.titleKey, award.rank, row, expiresAt, now)) {
      awarded++;
    }
  }

  return {
    seasonKey: row.key,
    ok: true,
    reason: plan.reason,
    frozen: standings.length,
    awarded,
  };
}

function grantSeasonTitle(
  wxId: string,
  titleKey: string,
  rank: number,
  season: SeasonRow,
  expiresAt: number,
  now: number,
): boolean {
  const user = db.select().from(users).where(eq(users.wxId, wxId)).get();
  /*
   * 榜上的人不一定注册过 —— daily_stats 是按 wx_id 统计的，
   * 而只有二十几个人在站上有账号。没账号就发不了称号，
   * 但**名次照样冻结**：他确实是这个赛季的第一名，
   * 只是这个站还没有能给他挂东西的地方。
   */
  if (!user) return false;

  const title = db.select().from(titles).where(eq(titles.key, titleKey)).get();
  if (!title) return false;

  const existing = db
    .select()
    .from(userTitles)
    .where(
      and(
        eq(userTitles.userId, user.id),
        eq(userTitles.titleId, title.id),
        isNull(userTitles.revokedAt),
      ),
    )
    .get();

  if (existing) {
    /*
     * 已经拿过这个称号（上个赛季也是冠军）——
     * 顺延到期日，而不是插一条新的：同一个人挂两个「赛季冠军」没有意义，
     * 而唯一索引也不允许。
     */
    db.update(userTitles)
      .set({ expiresAt: Math.max(existing.expiresAt ?? 0, expiresAt) })
      .where(eq(userTitles.id, existing.id))
      .run();
  } else {
    db.insert(userTitles)
      .values({
        userId: user.id,
        titleId: title.id,
        source: "seasonal",
        grantReason: `${season.name} ${rankLabel(rank)}`,
        expiresAt,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
  }

  notify({
    userId: user.id,
    type: "system",
    groupKey: `season:${season.id}:${titleKey}`,
    title: `${season.name} ${rankLabel(rank)}`,
    body: `解锁称号「${title.name}」 —— 挂到下个赛季结束`,
    link: "/leaderboard",
    refType: "season",
    refId: season.id,
  });

  return true;
}

/**
 * 扫一遍该结算的赛季。健康探测那一轮里调。
 *
 * 结算是**幂等**的：已经结算过的直接跳过，
 * 冻结用 onConflictDoNothing，称号已有就顺延而不是重发。
 */
export function settleDueSeasons(now = Date.now()): SettleSeasonResult[] {
  return pendingSettlement(now).map((row) => settleSeason(row, now));
}
