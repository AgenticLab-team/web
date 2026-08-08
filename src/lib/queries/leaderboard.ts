import "server-only";

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { dailyStats, people } from "@/lib/db/schema";
import { shiftDateKey, todayKey } from "@/lib/time";

/**
 * 排行榜查询。
 *
 * 主排序恒为**高质量消息数** —— 上游作者的原话是「按总条数排名会让复读机上榜」。
 * 总条数仍然展示，但只作为参考，不参与排名。
 */

export type Period = "week" | "month" | "all";

export const PERIODS: { key: Period; label: string; days: number | null }[] = [
  { key: "week", label: "本周", days: 7 },
  { key: "month", label: "本月", days: 30 },
  { key: "all", label: "总榜", days: null },
];

export interface BoardEntry {
  rank: number;
  wxId: string;
  name: string;
  avatarUrl: string | null;
  quality: number;
  messages: number;
  chars: number;
  /** 上一周期的名次，用于显示升降箭头 */
  previousRank: number | null;
}

export interface BoardOptions {
  period?: Period;
  /** 单个群，必须属于 convIds 之内 */
  convId?: string;
  /**
   * **必填**：这个人能看到的群。
   *
   * 不给默认值是刻意的 —— 有默认值就一定会有某个调用点忘了传，
   * 于是把全站数据泄露给只在两个群的人。忘了传的结果是空榜，不是全量榜。
   */
  convIds: string[];
  limit?: number;
}

function rangeFor(period: Period): { from: string | null; previousFrom: string | null; previousTo: string | null } {
  const today = todayKey();
  const spec = PERIODS.find((p) => p.key === period) ?? PERIODS[0];
  if (spec.days === null) return { from: null, previousFrom: null, previousTo: null };
  const from = shiftDateKey(today, -(spec.days - 1));
  return {
    from,
    previousFrom: shiftDateKey(from, -spec.days),
    previousTo: shiftDateKey(from, -1),
  };
}

function aggregate(
  from: string | null,
  to: string | null,
  convIds: string[],
  convId?: string,
  limit = 50,
) {
  const conditions = [inArray(dailyStats.convId, convIds)];
  if (from) conditions.push(gte(dailyStats.date, from));
  if (to) conditions.push(sql`${dailyStats.date} <= ${to}`);
  if (convId) conditions.push(eq(dailyStats.convId, convId));

  return db
    .select({
      wxId: dailyStats.wxId,
      quality: sql<number>`sum(${dailyStats.qualityMessages})`,
      messages: sql<number>`sum(${dailyStats.messages})`,
      chars: sql<number>`sum(${dailyStats.charsTotal})`,
    })
    .from(dailyStats)
    .where(and(...conditions))
    .groupBy(dailyStats.wxId)
    .having(sql`sum(${dailyStats.qualityMessages}) > 0`)
    .orderBy(desc(sql`sum(${dailyStats.qualityMessages})`), desc(sql`sum(${dailyStats.messages})`))
    .limit(limit)
    .all();
}

export function getLeaderboard(options: BoardOptions): BoardEntry[] {
  // 一个群都看不到的人（访客）拿到空榜，不是全量榜
  if (options.convIds.length === 0) return [];
  // 指定的群必须在可见范围内，否则当作看不到
  if (options.convId && !options.convIds.includes(options.convId)) return [];

  const period = options.period ?? "week";
  const limit = options.limit ?? 50;
  const { from, previousFrom, previousTo } = rangeFor(period);

  const current = aggregate(from, null, options.convIds, options.convId, limit);
  if (current.length === 0) return [];

  // 上一周期的名次，用来算升降。总榜没有「上一周期」，箭头不显示
  const previousRanks = new Map<string, number>();
  if (previousFrom && previousTo) {
    aggregate(previousFrom, previousTo, options.convIds, options.convId, 200).forEach((row, index) => {
      previousRanks.set(row.wxId, index + 1);
    });
  }

  const profiles = new Map(
    db
      .select({ wxId: people.wxId, name: people.displayName, avatar: people.avatarUrl })
      .from(people)
      .where(inArray(people.wxId, current.map((r) => r.wxId)))
      .all()
      .map((p) => [p.wxId, p]),
  );

  return current.map((row, index) => ({
    rank: index + 1,
    wxId: row.wxId,
    name: profiles.get(row.wxId)?.name ?? row.wxId,
    avatarUrl: profiles.get(row.wxId)?.avatar ?? null,
    quality: Number(row.quality),
    messages: Number(row.messages),
    chars: Number(row.chars),
    previousRank: previousRanks.get(row.wxId) ?? null,
  }));
}

/** 某个人在榜上的位置，用于「我的排名」。不在前 N 也要能查到 */
export function getMyRank(wxId: string, options: BoardOptions): BoardEntry | null {
  const full = getLeaderboard({ ...options, limit: 5000 });
  return full.find((entry) => entry.wxId === wxId) ?? null;
}

// 全量群列表不再对外提供 —— 群列表属于隐私，一律走 visibility.ts 的收口
