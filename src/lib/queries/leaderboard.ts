import "server-only";

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { dailyStats, people } from "@/lib/db/schema";
import { currentSeason } from "@/lib/seasons/queries";
import { dateRangeOf } from "@/lib/seasons/rules";
import { shiftDateKey, todayKey } from "@/lib/time";
import { resolveDisplayName } from "@/lib/users/display-name";

/**
 * 排行榜查询。
 *
 * 主排序恒为**高质量消息数** —— 上游作者的原话是「按总条数排名会让复读机上榜」。
 * 总条数仍然展示，但只作为参考，不参与排名。
 */

export type Period = "week" | "month" | "season" | "all";

/**
 * 赛季**排在总榜前面，而且是默认**。
 *
 * 总榜跑久了会冻住：最早那批人永远在前面，新来的人算一下就知道
 * 这辈子追不上，于是不再参与。赛季给的是一次「从零开始」的机会 ——
 * 但只有它是默认看到的那一屏，这件事才成立。
 *
 * 赛季的区间不是固定天数，要现查（见 rangeFor）。
 */
export const PERIODS: { key: Period; label: string; days: number | null }[] = [
  { key: "season", label: "本赛季", days: null },
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

function rangeFor(period: Period): {
  from: string | null;
  to?: string | null;
  previousFrom: string | null;
  previousTo: string | null;
} {
  const today = todayKey();

  /*
   * 赛季的区间由赛季表决定，不是「最近 N 天」。
   * 找不到当前赛季时退回总榜 —— 空榜看起来像出了故障。
   */
  if (period === "season") {
    const season = currentSeason();
    if (!season) return { from: null, previousFrom: null, previousTo: null };
    const { from, to } = dateRangeOf({
      key: season.key,
      name: season.name,
      startsAt: season.startsAt,
      endsAt: season.endsAt,
    });
    // 赛季没有「上一个同长度区间」可比，所以不显示升降箭头
    return { from, to, previousFrom: null, previousTo: null };
  }

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

  const period = options.period ?? "season";
  const limit = options.limit ?? 50;
  const { from, to, previousFrom, previousTo } = rangeFor(period);

  // 赛季有结束日，所以上界要传进去 —— 不传的话看历史赛季会把之后的也算进来
  const current = aggregate(from, to ?? null, options.convIds, options.convId, limit);
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
    // 兜底绝不能是 wx_id —— 排行榜对未登录访客公开，wx_id 漏出去就是隐私事故
    name: resolveDisplayName([profiles.get(row.wxId)?.name], { wxId: row.wxId }),
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
