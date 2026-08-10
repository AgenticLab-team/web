import "server-only";

import { sql } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { leaderboardHiddenWxIds } from "@/lib/privacy/queries";
import { assertGroupAccess } from "@/lib/queries/visibility";
import { resolveDisplayName } from "@/lib/users/display-name";

/**
 * 新人补课包。
 *
 * ─────────────────────────────────────────
 * 新人进群看不到历史，插不进话，两周后沉默退群
 * ─────────────────────────────────────────
 *
 * 这个站现在存着 45,000 条群聊 —— 而一个刚绑定的人打开首页，
 * 面对的是一个他完全没有上下文的信息流。他不知道这个群平时聊什么、
 * 谁是常驻、什么时候热闹，也不知道过去半年沉淀下了什么。
 *
 * 线上 118 个账号**全部是最近 30 天绑定的** —— 也就是说
 * 现在整站的人都正处在这个状态里。
 *
 * ─────────────────────────────────────────
 * 只用**真实存在的信号**，不编「精华」
 * ─────────────────────────────────────────
 *
 * 原计划里有一节「历史精华 Top 20」。做之前先查了数据，
 * 结论是**这个信号在这个站里不存在**：
 *
 *   · `is_quality` 只是「文本类且长度 ≥ 阈值」（见 lib/quality.ts）——
 *     它是长度的代理，不是质量的度量。照它排出来的 Top 20
 *     就是**二十条最长的消息**，而不是二十条最好的
 *   · `reply_to_id` 全表 45,584 条**一条都没有值** —— 上游
 *     不透传引用关系，这一点 lib/messages/reply.ts 已经写明了。
 *     所以「哪条消息引发了讨论」也无从得知
 *   · 论坛里 0 条提问、0 条采纳答案，「常见问题」同样没有来源
 *
 * 拿长度冒充精华比不做更糟：新人会以为这就是这个群最好的东西，
 * 然后据此判断要不要留下来。
 *
 * 所以这里只讲**数得出来的事实**：这个群多大、什么时候热闹、
 * 谁常在说话、最热闹的是哪几天、大家分享过什么。
 * 每一条都能追回到一张表。
 */

/** 常驻成员取几个 —— 再多就成了榜单，而这里要的是「记住几张脸」 */
const TOP_VOICES = 8;
/** 最热闹的日子取几天 */
const BUSIEST_DAYS = 5;
/** 资源取几条 */
const TOP_LINKS = 6;
/** 「最近有多少人在说话」的窗口 */
const RECENT_DAYS = 30;

export interface CatchupVoice {
  wxId: string;
  name: string;
  avatarUrl: string | null;
  messages: number;
  quality: number;
  /** 这个人最常在几点说话 —— 「他一般晚上在」比条数更像认识一个人 */
  peakHour: number | null;
  /** 就是看这一页的人自己 */
  isYou: boolean;
}

export interface CatchupDay {
  date: string;
  messages: number;
  speakers: number;
}

export interface CatchupLink {
  id: string;
  url: string;
  title: string;
  domain: string;
  shareCount: number;
  voteCount: number;
}

export interface GroupCatchup {
  convId: string;
  name: string;
  memberCount: number;
  messageCount: number;
  /** 有记录的第一天 / 最后一天 */
  firstDay: string | null;
  lastDay: string | null;
  /** 有人说过话的天数 —— 不是日历天数 */
  activeDays: number;
  /** 活跃日均条数。用有记录的天算，不然长期潜水的群会被摊平成 0 */
  perActiveDay: number;
  /** 24 格小时分布，用来画节奏条 */
  hours: number[];
  /** 最近 30 天有多少人说过话 —— 「这个群现在还活着吗」 */
  recentSpeakers: number;
  busiestDays: CatchupDay[];
  voices: CatchupVoice[];
  links: CatchupLink[];
}

/**
 * 一个群的补课包。
 *
 * `assertGroupAccess` 放在最前面 —— 「群列表属于隐私，登录用户
 * 也只能看到自己所在的群的信息」是这个站的硬规矩，
 * 而这一页会把群名、成员、热门时段一次全端出来。
 */
export function groupCatchup(user: CurrentUser | null, convId: string): GroupCatchup | null {
  /*
   * **它返回 null，不抛异常** —— 名字里的 assert 会骗人。
   *
   * 只写一句 `assertGroupAccess(user, convId);` 把返回值丢掉的话，
   * 这一页对任何一个登录用户都会端出**任何一个群**的
   * 群名、常驻成员和活跃时段。写这个文件的第一版就是这么错的。
   */
  if (!assertGroupAccess(user, convId)) return null;

  const head = db
    .all<{ name: string; memberCount: number; messageCount: number }>(
      sql`SELECT g.name AS name,
                 g.member_count AS memberCount,
                 (SELECT count(*) FROM messages m WHERE m.conv_id = g.conv_id) AS messageCount
          FROM groups g WHERE g.conv_id = ${convId}`,
    )
    .at(0);

  if (!head) return null;

  /*
   * 节奏从 `daily_stats` 算，不从 `messages` 现扫。
   *
   * 那张表就是为这类聚合存在的（每人每天一行），
   * 而 messages 有 45,000 条 —— 一次页面渲染扫全表，
   * 在手机上就是白屏几百毫秒。
   */
  const shape = db
    .all<{
      activeDays: number;
      total: number;
      firstDay: string | null;
      lastDay: string | null;
    }>(
      sql`SELECT count(DISTINCT date) AS activeDays,
                 coalesce(sum(messages), 0) AS total,
                 min(date) AS firstDay,
                 max(date) AS lastDay
          FROM daily_stats WHERE conv_id = ${convId}`,
    )
    .at(0);

  const activeDays = Number(shape?.activeDays ?? 0);
  const total = Number(shape?.total ?? 0);

  const hours = new Array<number>(24).fill(0);
  for (const row of db.all<{ h: string | null }>(
    sql`SELECT hour_histogram AS h FROM daily_stats WHERE conv_id = ${convId}`,
  )) {
    /*
     * 这一列历史上被双重编码过（见 lib/db/repairs.ts）。
     * 修复已经跑完，但读的这一侧仍然不假设形状 ——
     * 一条坏行不该让整页 500。
     */
    let parsed: unknown = row.h;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        continue;
      }
    }
    if (!Array.isArray(parsed)) continue;
    for (let i = 0; i < 24; i++) {
      const v = parsed[i];
      if (typeof v === "number" && Number.isFinite(v)) hours[i] += v;
    }
  }

  const recentSpeakers = Number(
    db
      .all<{ n: number }>(
        sql`SELECT count(DISTINCT wx_id) AS n FROM daily_stats
            WHERE conv_id = ${convId}
              AND date >= date('now', '+8 hours', ${`-${RECENT_DAYS} days`})`,
      )
      .at(0)?.n ?? 0,
  );

  const busiestDays = db
    .all<{ date: string; messages: number; speakers: number }>(
      sql`SELECT date,
                 sum(messages) AS messages,
                 count(DISTINCT wx_id) AS speakers
          FROM daily_stats WHERE conv_id = ${convId}
          GROUP BY date
          ORDER BY messages DESC, date DESC
          LIMIT ${BUSIEST_DAYS}`,
    )
    .map((r) => ({
      date: r.date,
      messages: Number(r.messages),
      speakers: Number(r.speakers),
    }));

  return {
    convId,
    name: head.name,
    memberCount: Number(head.memberCount ?? 0),
    messageCount: Number(head.messageCount ?? 0),
    firstDay: shape?.firstDay ?? null,
    lastDay: shape?.lastDay ?? null,
    activeDays,
    perActiveDay: activeDays > 0 ? Math.round(total / activeDays) : 0,
    hours,
    recentSpeakers,
    busiestDays,
    voices: topVoices(user, convId),
    links: topLinks(convId),
  };
}

/**
 * 常驻成员。
 *
 * ─────────────────────────────────────────
 * 隐私判定不在这里写第二遍
 * ─────────────────────────────────────────
 *
 * 「不出现在公开榜单」这个开关必须在这一页同样生效 ——
 * 一个人把自己从榜上摘了，结果在「谁是谁」里被当成常驻介绍给每个新人，
 * 那个开关就等于没有。
 *
 * 名单直接问 `leaderboardHiddenWxIds`，不自己查 `user_privacy`：
 * 豁免规则（管理员看得到全部、自己永远看得到自己）只有那一处实现。
 */
function topVoices(user: CurrentUser | null, convId: string): CatchupVoice[] {
  const hidden = leaderboardHiddenWxIds(user);

  const rows = db.all<{
    wxId: string;
    messages: number;
    quality: number;
    displayName: string | null;
    avatarUrl: string | null;
    hours: string | null;
  }>(
    sql`SELECT s.wx_id AS wxId,
               sum(s.messages) AS messages,
               sum(s.quality_messages) AS quality,
               p.display_name AS displayName,
               p.avatar_url AS avatarUrl,
               (SELECT hour_histogram FROM daily_stats d
                 WHERE d.wx_id = s.wx_id AND d.conv_id = s.conv_id
                 ORDER BY d.messages DESC LIMIT 1) AS hours
        FROM daily_stats s
        LEFT JOIN people p ON p.wx_id = s.wx_id
        WHERE s.conv_id = ${convId}
        GROUP BY s.wx_id
        ORDER BY quality DESC, messages DESC
        LIMIT ${TOP_VOICES + hidden.length}`,
  );

  const hiddenSet = new Set(hidden);

  return rows
    .filter((r) => !hiddenSet.has(r.wxId))
    .slice(0, TOP_VOICES)
    .map((r) => ({
      wxId: r.wxId,
      /*
       * 走 `resolveDisplayName` 而不是直接用 display_name ——
       * 它的兜底保证**永远不会回落成 wx_id**。
       * 微信号出现在页面上是隐私事故，而没有档案的人正好会走兜底。
       */
      name: resolveDisplayName([r.displayName], { wxId: r.wxId, fallback: "群成员" }),
      avatarUrl: r.avatarUrl,
      messages: Number(r.messages),
      quality: Number(r.quality),
      peakHour: peakHourOf(r.hours),
      isYou: !!user?.wxId && user.wxId === r.wxId,
    }));
}

/** 从一行小时分布里挑最高的那一格。形状不对就返回 null，不猜 */
export function peakHourOf(raw: unknown): number | null {
  let parsed: unknown = raw;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length !== 24) return null;

  let best = -1;
  let bestAt: number | null = null;
  for (let i = 0; i < 24; i++) {
    const v = parsed[i];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (v > best) {
      best = v;
      bestAt = i;
    }
  }
  // 全是 0 的时候没有「最常出现的时段」，别把 0 点当答案
  return best > 0 ? bestAt : null;
}

/**
 * 这个群分享过什么。
 *
 * 按**被分享次数**排，不按点赞 —— 点赞是站里的行为，
 * 而这个站刚上线，几乎所有链接的点赞都是 0；
 * 被同一批人反复贴出来才是群里真实发生过的事。
 *
 * `hidden` 的不要：广告和失效链接是管理员一条条标掉的，
 * 让它们出现在新人看到的第一屏，等于把清理白做了。
 */
function topLinks(convId: string): CatchupLink[] {
  return db
    .all<{
      id: string;
      url: string;
      title: string;
      domain: string;
      shareCount: number;
      voteCount: number;
      inGroup: number;
    }>(
      sql`SELECT l.id, l.url,
                 coalesce(nullif(l.ai_title, ''), l.title) AS title,
                 l.domain,
                 l.share_count AS shareCount,
                 l.vote_count AS voteCount,
                 count(lm.id) AS inGroup
          FROM link_mentions lm
          JOIN links l ON l.id = lm.link_id
          WHERE lm.conv_id = ${convId} AND l.hidden = 0
          GROUP BY l.id
          ORDER BY inGroup DESC, l.vote_count DESC, l.last_shared_at DESC
          LIMIT ${TOP_LINKS}`,
    )
    .map((r) => ({
      id: r.id,
      url: r.url,
      title: r.title,
      domain: r.domain,
      shareCount: Number(r.shareCount),
      voteCount: Number(r.voteCount),
    }));
}

/**
 * 这个群「值不值得单独讲一页」。
 *
 * 一个 0 条消息的群（线上真有一个）什么都算不出来 ——
 * 端一屏「0 条消息 / 0 个常驻 / 没有链接」给新人看，
 * 比不显示这个群更糟：它看起来像是站坏了。
 */
export function hasEnoughToShow(pack: GroupCatchup): boolean {
  return pack.messageCount > 0 && pack.activeDays > 0;
}
