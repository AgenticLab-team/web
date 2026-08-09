import "server-only";

import { and, desc, eq, gte, inArray, notInArray, sql } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { dailyStats, people } from "@/lib/db/schema";
import { leaderboardHiddenWxIds } from "@/lib/privacy/queries";
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
  /**
   * 看榜的是谁。未登录传 null。
   *
   * 两个用途：
   *
   * 1. **把「不想上榜」的人排掉，但不排掉看榜的人自己** ——
   *    自己那一行永远在，否则拨了开关的人没有任何办法确认它生效了，
   *    只能靠相信，而只能靠相信的隐私开关跟没有是一样的。
   * 2. **管理员看到的是完整的榜**（见 privacy/queries.ts 的豁免）。
   *    界面上会把「别人看不到的那几行」标出来 ——
   *    不标的话管理员会以为公开的榜就长这样，
   *    然后照着一个只有他自己看得到的名次去发公告、发奖。
   *
   * 传整个 user 而不是 wx_id：豁免要判权限，而权限判断只该有一处。
   */
  viewer?: CurrentUser | null;
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
  hiddenWxIds: string[] = [],
) {
  const conditions = [inArray(dailyStats.convId, convIds)];
  if (from) conditions.push(gte(dailyStats.date, from));
  if (to) conditions.push(sql`${dailyStats.date} <= ${to}`);
  if (convId) conditions.push(eq(dailyStats.convId, convId));
  /*
   * 藏起来的人在**聚合之前**就排掉，不是查完再 filter。
   *
   * 查完再 filter 的话名次会错得很难看：第 3 名被滤掉之后，
   * 原来的第 4 名仍然显示「第 4 名」，而榜上只有 49 行 ——
   * 谁都看得出少了一个人，只是不知道少了谁。那等于把「有人藏起来了」
   * 这件事本身广播出去，而藏起来的人最不想要的就是这个。
   */
  if (hiddenWxIds.length > 0) conditions.push(notInArray(dailyStats.wxId, hiddenWxIds));

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

  const hidden = leaderboardHiddenWxIds(options.viewer ?? null);

  // 赛季有结束日，所以上界要传进去 —— 不传的话看历史赛季会把之后的也算进来
  const current = aggregate(from, to ?? null, options.convIds, options.convId, limit, hidden);
  if (current.length === 0) return [];

  // 上一周期的名次，用来算升降。总榜没有「上一周期」，箭头不显示。
  // 同一份排除名单要用在这里 —— 两边口径不一样的话，箭头会指向一个
  // 从来没在榜上出现过的名次，比不显示箭头更让人困惑。
  const previousRanks = new Map<string, number>();
  if (previousFrom && previousTo) {
    aggregate(previousFrom, previousTo, options.convIds, options.convId, 200, hidden).forEach(
      (row, index) => {
        previousRanks.set(row.wxId, index + 1);
      },
    );
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

/**
 * 某个人在榜上的位置，用于「我的排名」。不在前 N 也要能查到。
 *
 * **viewer 一定是他自己**：一个关掉了「出现在榜单上」的人打开榜单，
 * 看到的是别人看不到他、但他自己那一行还在 ——
 * 这是他确认开关真的生效了的唯一途径。
 */
export function getMyRank(user: CurrentUser | null, options: BoardOptions): BoardEntry | null {
  // 收 null 而不是让每个调用点自己判 —— 少一处三元表达式，也少一处判错的机会
  if (!user?.wxId) return null;
  const full = getLeaderboard({ ...options, limit: 5000, viewer: user });
  return full.find((entry) => entry.wxId === user.wxId) ?? null;
}

// 全量群列表不再对外提供 —— 群列表属于隐私，一律走 visibility.ts 的收口
