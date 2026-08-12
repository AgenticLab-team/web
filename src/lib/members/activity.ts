import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { dailyStats } from "@/lib/db/schema";
import { hiddenWxIds } from "@/lib/privacy/queries";

import {
  addHistograms,
  normalizeHistogram,
  summarizeHours,
  type HourSummary,
} from "./hours";

/**
 * 「他一般什么时候说话」—— 读 `daily_stats.hour_histogram`。
 *
 * ═════════════════════════════════════════
 * 这一列每天在写，但在此之前没有任何地方读它来展示
 * ═════════════════════════════════════════
 *
 * 同步时逐条消息按小时累加进去，写了七百多天。
 * 而它守着的那个隐私开关（`hide_activity_hours`）当初被删掉，
 * 理由正是「它守的东西不存在」—— 一个写了两年、没人读的列，
 * 和一个守着不存在功能的开关，是同一个病的两面。
 *
 * 这里把它接上，开关也跟着回来了。
 *
 * ═════════════════════════════════════════
 * 不做缓存，因为它本来就是缓存
 * ═════════════════════════════════════════
 *
 * `daily_stats` 已经是按天预聚合的：一个人在一个群里一天一行。
 * 最活跃的人两年也就一千多行，取出来在内存里加一遍是几毫秒 ——
 * 再为它建一层缓存，是给一个已经算好的东西再算一次。
 */
export function activityHoursFor(
  viewer: CurrentUser | null,
  wxId: string,
  convIds: string[],
  /** 已经算好的隐私名单，省一次重复的权限判定 */
  hidden?: ReadonlySet<string>,
): HourSummary | null {
  if (convIds.length === 0) return null;

  /*
   * 这一条走**自己的**开关，不是「别人能搜到我的发言」那一个。
   *
   * 两者暴露的东西不是一个量级：那个露的是「你说过什么」，
   * 这个露的是**你什么时候醒着** —— 几点睡、几点起、是不是上夜班。
   * 共用一个开关的话，想藏作息的人得连发言一起藏。
   */
  const off = hidden ?? new Set(hiddenWxIds(viewer).activityHours);
  if (off.has(wxId)) return null;

  const rows = db
    .select({ hours: dailyStats.hourHistogram })
    .from(dailyStats)
    .where(and(eq(dailyStats.wxId, wxId), inArray(dailyStats.convId, convIds)))
    .all();

  let total: number[] | null = null;
  for (const row of rows) {
    const hist = normalizeHistogram(row.hours);
    if (!hist) continue;
    total = total ? addHistograms(total, hist) : hist;
  }

  return total ? summarizeHours(total) : null;
}
