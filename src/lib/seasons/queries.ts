import "server-only";

import { and, asc, desc, eq, gt, isNull, lte } from "drizzle-orm";

import { db, sqlite } from "@/lib/db";
import { seasonStandings, seasons } from "@/lib/db/schema";
import {
  dateRangeOf,
  daysLeft,
  quarterSeasons,
  rankStandings,
  statusOf,
  type Season,
  type SeasonStatus,
  type Standing,
} from "@/lib/seasons/rules";

/**
 * 赛季的读取。
 *
 * 赛季榜是**现算**的：按赛季的日期范围聚合 daily_stats。
 * 已结算的赛季读冻结下来的快照 —— daily_stats 会被存储裁剪动到，
 * 而「2026 春季赛冠军是谁」一旦发生就不该再变。
 */

export type SeasonRow = typeof seasons.$inferSelect;

export interface SeasonView {
  id: string;
  key: string;
  name: string;
  startsAt: number;
  endsAt: number;
  status: SeasonStatus;
  daysLeft: number;
  settledAt: number | null;
  settleNote: string | null;
}

function toSeason(row: SeasonRow): Season {
  return { key: row.key, name: row.name, startsAt: row.startsAt, endsAt: row.endsAt };
}

export function viewOf(row: SeasonRow, now = Date.now()): SeasonView {
  const season = toSeason(row);
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: statusOf(season, now),
    daysLeft: daysLeft(season, now),
    settledAt: row.settledAt,
    settleNote: row.settleNote,
  };
}

/**
 * 当前赛季。没有就现造一个 ——
 * 赛季表空着不该让榜单变成空白，那看起来像出了故障。
 */
export function currentSeason(now = Date.now()): SeasonRow | null {
  const row = db
    .select()
    .from(seasons)
    .where(and(lte(seasons.startsAt, now), gt(seasons.endsAt, now)))
    .get();
  if (row) return row;

  const year = new Date(now + 8 * 3600_000).getUTCFullYear();
  const spec = quarterSeasons(year).find((s) => now >= s.startsAt && now < s.endsAt);
  if (!spec) return null;

  db.insert(seasons)
    .values({ key: spec.key, name: spec.name, startsAt: spec.startsAt, endsAt: spec.endsAt })
    .onConflictDoNothing()
    .run();

  return db.select().from(seasons).where(eq(seasons.key, spec.key)).get() ?? null;
}

/**
 * 当前赛季的视图（含倒计时）。
 *
 * 页面要的是「还剩几天」，而那个数要在**服务端**算好 ——
 * 客户端组件在渲染里调 Date.now() 会让两端算出不同的值，
 * 而那种不一致只在某些时刻出现。lint 里的 purity 规则就是拦这个的。
 */
export function currentSeasonView(now = Date.now()): SeasonView | null {
  const row = currentSeason(now);
  return row ? viewOf(row, now) : null;
}

export function seasonByKey(key: string): SeasonRow | null {
  return db.select().from(seasons).where(eq(seasons.key, key)).get() ?? null;
}

export function listSeasons(limit = 12): SeasonRow[] {
  return db.select().from(seasons).orderBy(desc(seasons.startsAt)).limit(limit).all();
}

/** 已经结束但还没结算的 —— 结算任务扫这个 */
export function pendingSettlement(now = Date.now()): SeasonRow[] {
  return db
    .select()
    .from(seasons)
    .where(and(lte(seasons.endsAt, now), isNull(seasons.settledAt)))
    .orderBy(asc(seasons.startsAt))
    .all();
}

/**
 * 赛季榜。
 *
 * 只统计**看得到的群** —— 和总榜同一条规矩：
 * 可以公开「谁贡献最多」，不可以让一个人从榜单上推出别的群有什么人。
 */
export function seasonBoard(
  row: SeasonRow,
  convIds: string[],
  limit = 50,
): Standing[] {
  // 已结算的读快照：现算的话，存储裁剪之后冠军会悄悄换人
  if (row.settledAt !== null) {
    return db
      .select()
      .from(seasonStandings)
      .where(eq(seasonStandings.seasonId, row.id))
      .orderBy(asc(seasonStandings.rank))
      .limit(limit)
      .all()
      .map((s) => ({
        wxId: s.wxId,
        rank: s.rank,
        quality: s.quality,
        messages: s.messages,
        chars: s.chars,
      }));
  }

  if (convIds.length === 0) return [];
  const { from, to } = dateRangeOf(toSeason(row));
  const placeholders = convIds.map(() => "?").join(",");

  const rows = sqlite
    .prepare(
      `SELECT wx_id AS wxId,
              SUM(quality_messages) AS quality,
              SUM(messages) AS messages,
              SUM(chars_total) AS chars
       FROM daily_stats
       WHERE conv_id IN (${placeholders}) AND date >= ? AND date <= ?
       GROUP BY wx_id
       HAVING quality > 0
       ORDER BY quality DESC, messages DESC
       LIMIT ?`,
    )
    .all(...convIds, from, to, limit) as {
    wxId: string;
    quality: number;
    messages: number;
    chars: number;
  }[];

  return rankStandings(rows);
}

/** 某个人在某赛季的名次；不在榜上返回 null */
export function myStanding(
  row: SeasonRow,
  wxId: string | null,
  convIds: string[],
): Standing | null {
  if (!wxId) return null;
  // 取全量再找自己 —— 榜只有几十人，多一次聚合不如少一段特例代码
  return seasonBoard(row, convIds, 500).find((s) => s.wxId === wxId) ?? null;
}

/** 历届冠亚季军，给赛季历史页 */
export function podiumOf(seasonId: string) {
  return db
    .select()
    .from(seasonStandings)
    .where(and(eq(seasonStandings.seasonId, seasonId), lte(seasonStandings.rank, 3)))
    .orderBy(asc(seasonStandings.rank))
    .all();
}
