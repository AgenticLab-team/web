import "server-only";

import { desc, eq } from "drizzle-orm";

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

export { checkNoise };
