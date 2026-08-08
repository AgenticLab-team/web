import "server-only";

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { dailyStats, groups, people } from "@/lib/db/schema";
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
  convId?: string;
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

function aggregate(from: string | null, to: string | null, convId?: string, limit = 50) {
  const conditions = [];
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
    .where(conditions.length ? and(...conditions) : undefined)
    .groupBy(dailyStats.wxId)
    .having(sql`sum(${dailyStats.qualityMessages}) > 0`)
    .orderBy(desc(sql`sum(${dailyStats.qualityMessages})`), desc(sql`sum(${dailyStats.messages})`))
    .limit(limit)
    .all();
}

export function getLeaderboard(options: BoardOptions = {}): BoardEntry[] {
  const period = options.period ?? "week";
  const limit = options.limit ?? 50;
  const { from, previousFrom, previousTo } = rangeFor(period);

  const current = aggregate(from, null, options.convId, limit);
  if (current.length === 0) return [];

  // 上一周期的名次，用来算升降。总榜没有「上一周期」，箭头不显示
  const previousRanks = new Map<string, number>();
  if (previousFrom && previousTo) {
    aggregate(previousFrom, previousTo, options.convId, 200).forEach((row, index) => {
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
export function getMyRank(wxId: string, options: BoardOptions = {}): BoardEntry | null {
  const full = getLeaderboard({ ...options, limit: 5000 });
  return full.find((entry) => entry.wxId === wxId) ?? null;
}

export function syncedGroups() {
  return db
    .select({ convId: groups.convId, name: groups.name, messageCount: groups.messageCount })
    .from(groups)
    .where(eq(groups.syncEnabled, true))
    .orderBy(desc(groups.messageCount))
    .all();
}
