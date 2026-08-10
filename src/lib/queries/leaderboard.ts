import "server-only";

import { and, desc, eq, gte, inArray, notInArray, sql } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { dailyStats, people, users } from "@/lib/db/schema";
import { leaderboardPrivacy } from "@/lib/privacy/queries";
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
  /**
   * 这一行**别人看不到**。
   *
   * ─────────────────────────────────────────
   * 只有能绕过隐私的人才拿得到这个字段
   * ─────────────────────────────────────────
   *
   * 管理员看到的是完整的榜（`leaderboardHiddenWxIds` 对他返回空名单），
   * 而界面上不标出来的话，他会以为公开的榜就长这样 ——
   * 然后照着一个**只有他自己看得到的名次**去发公告、发奖。
   * 那是一次好心办出来的隐私事故。
   *
   * 反过来，这个字段绝不能给普通成员：告诉他们「谁把自己藏了」，
   * 等于把那个开关直接废掉 —— 藏起来的人反而更显眼。
   * 所以非特权视角下它恒为 undefined，不是 false。
   */
  hiddenFromOthers?: boolean;
  /**
   * 访客看到的是「群成员」—— 这个人还没注册过本站。
   *
   * 和上面那条一样只给特权视角：管理员要知道自己看到的名字，
   * 有哪些是访客看不到的。
   */
  anonymousToGuests?: boolean;
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

  /*
   * 一次算完：该排除谁、这个人是不是管理员、以及（只对管理员）
   * 哪几行别人看不到。
   *
   * 豁免判定全部在 `privacy/queries.ts` 里 —— 这里再判一遍的话，
   * 一是权限解析要跑两遍（一次榜单多三条 SQL），
   * 二是漏判的方向永远是「把关掉开关的人重新暴露出去」。
   */
  const privacy = leaderboardPrivacy(options.viewer ?? null);
  const hidden = privacy.hidden;
  const privileged = privacy.privileged;
  const hiddenSet = privacy.hiddenForAudit;

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

  /*
   * ─────────────────────────────────────────
   * 没注册过这个站的人，对访客不具名
   * ─────────────────────────────────────────
   *
   * 榜单是按 `daily_stats` 的 wx_id 聚合的 —— 也就是说
   * **群里的每一个人都在榜上，包括从没打开过这个站的人**。
   * 线上第 4 活跃的那位就没有账号。
   *
   * 而退出榜单的开关（`user_privacy.hide_from_leaderboard`）
   * 需要一个账号才拨得动。于是暴露对所有人成立，
   * 而退出只对加入过的人开放 —— 这条不对称站不住。
   *
   * 隐私页自己写着：「这个站把发言量做成了对未登录访客公开的榜单，
   * 这是微信里不存在的暴露」。一个从没来过的人，
   * 不该因为别人建了这个站而把微信昵称和头像挂到公网上。
   *
   * ─────────────────────────────────────────
   * 只对访客隐去名字，不隐去这个人
   * ─────────────────────────────────────────
   *
   * 名次和条数照旧 —— 那是社区真实的活跃分布，抹掉它等于让榜单说假话。
   * 隐去的只有身份：名字和头像。
   *
   * 登录成员看得到全名：他们和这些人在同一批群里，
   * 那些昵称他们每天都在微信里看见，这里没有多出新的暴露。
   */
  const anonymize = !options.viewer;
  /* 特权视角也要知道「访客看到的是谁」，所以这一步对它同样要跑 */
  const needRegistered = anonymize || privileged;
  const registered = needRegistered
    ? new Set(
        db
          .select({ wxId: users.wxId })
          .from(users)
          .where(inArray(users.wxId, current.map((r) => r.wxId)))
          .all()
          .map((u) => u.wxId)
          .filter((w): w is string => Boolean(w)),
      )
    : null;

  return current.map((row, index) => ({
    rank: index + 1,
    wxId: row.wxId,
    // 兜底绝不能是 wx_id —— 排行榜对未登录访客公开，wx_id 漏出去就是隐私事故
    name:
      anonymize && registered && !registered.has(row.wxId)
        ? "群成员"
        : resolveDisplayName([profiles.get(row.wxId)?.name], { wxId: row.wxId }),
    avatarUrl:
      anonymize && registered && !registered.has(row.wxId)
        ? null
        : (profiles.get(row.wxId)?.avatar ?? null),
    ...(privileged
      ? {
          hiddenFromOthers: hiddenSet?.has(row.wxId) ?? false,
          anonymousToGuests: !(registered?.has(row.wxId) ?? true),
        }
      : {}),
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
