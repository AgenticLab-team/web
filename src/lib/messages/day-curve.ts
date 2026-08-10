import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

/**
 * 一天里的活跃度曲线。
 *
 * ─────────────────────────────────────────
 * 一天一千多条，翻是翻不动的
 * ─────────────────────────────────────────
 *
 * 线上最热闹的那天：1,274 条、48 个人。按天回看能落到那一天，
 * 但落进去之后是几十页 —— 「上周三那个讨论」还是得一页页找。
 *
 * 而真实的一天不是均匀的：白天零星几句，晚上某个话题突然炸出
 * 三百条。**知道那三百条在几点，和不知道，是两种体验**。
 *
 * ─────────────────────────────────────────
 * 每一格都得能点进去
 * ─────────────────────────────────────────
 *
 * 只画一条曲线的话，人看完还是得自己翻 —— 那只是把「不知道在哪」
 * 变成「知道在哪但还是够不着」。
 *
 * 所以每一格都带上**那个小时第一条消息的 id**，
 * 链接直接走已有的 `?m=<id>`：那一套会算出页码、渲染那一页、
 * 高亮那一条，并让浏览器滚到它（见 lib/messages/locate.ts）。
 * 曲线因此不是装饰，是导航。
 */

export interface DayHour {
  /** 0~23，东八区 */
  hour: number;
  count: number;
  /** 这个小时的第一条消息。没有消息时是 null */
  firstId: string | null;
}

export interface DayCurve {
  hours: DayHour[];
  total: number;
  /** 最忙的那个小时。一条消息都没有时是 null */
  peakHour: number | null;
}

/**
 * 取某个群某一天的小时分布。
 *
 * ─────────────────────────────────────────
 * 从 messages 算，不从 daily_stats
 * ─────────────────────────────────────────
 *
 * `daily_stats.hour_histogram` 是现成的，但它有两个问题：
 *
 *   · 它按「人 × 天」存，要用得把当天所有人的数组加起来 ——
 *     而这一页只关心整个群的形状
 *   · 更要紧的是**它给不出消息 id**。而没有 id，
 *     每一格就点不进去，曲线就只剩装饰
 *
 * 而且那一列历史上漂移过（条数对、直方图短，见 lib/db/repairs.ts）。
 * 这里读的是消息本体，和页面上真正列出来的东西同源 ——
 * 曲线说 22 点有 300 条，翻过去就该有 300 条。
 *
 * 日期边界按**东八区**切，和 `dateKey` 一致。少加 8 小时的话，
 * 凌晨那几条会落到前一天。
 */
export function dayCurve(convId: string, date: string): DayCurve {
  /*
   * `min(ts)` 配裸列 `id` —— 这是 SQLite 明文保证的行为：
   * 聚合查询里用了 min()/max() 时，结果集里的裸列取自**命中那一行**。
   *
   * 写成关联子查询也能对，但那是每个小时再扫一遍当天的消息；
   * 一天上千条、24 个小时，白白多扫二十几遍。
   *
   * 这条保证是 SQLite 特有的（换库要重写），所以单独写明白，
   * 而不是让下一个人以为这是 SQL 通例。
   */
  const rows = db.all<{ hour: number; count: number; firstId: string }>(
    sql`SELECT CAST(strftime('%H', ts / 1000, 'unixepoch', '+8 hours') AS INTEGER) AS hour,
               count(*) AS count,
               min(ts) AS firstTs,
               id AS firstId
        FROM messages
        WHERE conv_id = ${convId}
          AND date(ts / 1000, 'unixepoch', '+8 hours') = ${date}
        GROUP BY hour
        ORDER BY hour`,
  );

  const byHour = new Map(rows.map((r) => [Number(r.hour), r]));

  const hours: DayHour[] = [];
  let total = 0;
  let peak = -1;
  let peakHour: number | null = null;

  for (let h = 0; h < 24; h++) {
    const row = byHour.get(h);
    const count = Number(row?.count ?? 0);
    total += count;
    if (count > peak) {
      peak = count;
      peakHour = count > 0 ? h : null;
    }
    hours.push({ hour: h, count, firstId: row?.firstId ?? null });
  }

  return { hours, total, peakHour };
}
