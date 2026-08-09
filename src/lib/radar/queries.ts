import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { keywordHits, keywordSubs } from "@/lib/db/schema";
import { MAX_HITS_PER_DAY, checkNoise, isNewDay } from "@/lib/radar/match";

export interface RadarSub {
  id: string;
  keyword: string;
  enabled: boolean;
  totalHits: number;
  hitsToday: number;
  lastNotifiedAt: number | null;
  hits7dAtCreate: number;
  /** 今天是否已经到了封顶 —— 要让人看得出「还在响，只是不通知了」 */
  cappedToday: boolean;
  recent: {
    id: string;
    snippet: string | null;
    senderName: string | null;
    notified: boolean;
    hitAt: number;
  }[];
}

export function mySubs(userId: string, now = Date.now()): RadarSub[] {
  const subs = db
    .select()
    .from(keywordSubs)
    .where(eq(keywordSubs.userId, userId))
    .orderBy(desc(keywordSubs.createdAt))
    .all();

  return subs.map((sub) => {
    // 跨天了就按 0 显示 —— 存的那个数字是昨天的
    const hitsToday = isNewDay(sub.lastNotifiedAt, now) ? 0 : sub.hitsToday;
    return {
      id: sub.id,
      keyword: sub.keyword,
      enabled: sub.enabled,
      totalHits: sub.totalHits,
      hitsToday,
      lastNotifiedAt: sub.lastNotifiedAt,
      hits7dAtCreate: sub.hits7dAtCreate,
      cappedToday: hitsToday >= MAX_HITS_PER_DAY,
      recent: db
        .select({
          id: keywordHits.id,
          snippet: keywordHits.snippet,
          senderName: keywordHits.senderName,
          notified: keywordHits.notified,
          hitAt: keywordHits.hitAt,
        })
        .from(keywordHits)
        .where(eq(keywordHits.subId, sub.id))
        .orderBy(desc(keywordHits.hitAt))
        .limit(5)
        .all(),
    };
  });
}

export function subById(userId: string, subId: string) {
  return (
    db
      .select()
      .from(keywordSubs)
      .where(and(eq(keywordSubs.id, subId), eq(keywordSubs.userId, userId)))
      .get() ?? null
  );
}

/**
 * 一个订阅的完整命中记录。
 *
 * **被封顶压掉的那些也列出来**，标成「没通知」——
 * 不列的话，用户看到「今天提醒 5 次」会以为总共就响了 5 次，
 * 而实际上可能响了三十次。少通知是有意的，瞒着不说不是。
 */
export function hitsOf(userId: string, subId: string, limit = 50) {
  if (!subById(userId, subId)) return [];
  return db
    .select()
    .from(keywordHits)
    .where(eq(keywordHits.subId, subId))
    .orderBy(desc(keywordHits.hitAt))
    .limit(limit)
    .all();
}

export { checkNoise };
