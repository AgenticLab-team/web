import "server-only";

import { sql } from "drizzle-orm";

import { db } from "./index";

/**
 * 一次性数据修复。
 *
 * ─────────────────────────────────────────
 * 为什么单独一个文件
 * ─────────────────────────────────────────
 *
 * 代码里的 bug 修掉之后，**它写进库里的坏数据不会自己变好**。
 * 而这类修复有一批共同的要求：
 *
 *   · **幂等** —— 每次启动都跑，修完之后就再也匹配不到行
 *   · **说得出为什么** —— 「这段代码在修什么」半年后没人记得
 *   · **报出数字** —— 修了几行要看得见，否则修没修过都不知道
 *
 * 散在 seed 里的话，那个文件会慢慢变成一个谁也不敢动的大杂烩。
 *
 * ─────────────────────────────────────────
 * 只修**能确定**的
 * ─────────────────────────────────────────
 *
 * 每一条都必须能从坏数据里**无歧义地还原**出正确值。
 * 猜不出来的不要修 —— 一次猜错的批量写入比坏数据本身糟得多，
 * 因为坏数据至少还看得出是坏的。
 */

export interface RepairResult {
  key: string;
  /** 修好了几行。0 表示没有需要修的（正常状态） */
  fixed: number;
}

interface Repair {
  key: string;
  why: string;
  run: (tx: typeof db) => number;
}

const REPAIRS: readonly Repair[] = [
  {
    key: "notification-title-type",
    why:
      "称号解锁原来发的是 `system`，而 `system` 是关不掉的 —— " +
      "旧通知不改签的话，它们会永远躺在「系统公告」那一档下面，" +
      "用户按类型筛选、按类型静音时看到的都是错的",
    run: (tx) =>
      tx
        .run(
          sql`UPDATE notifications SET type = 'title'
              WHERE type = 'system' AND title LIKE '解锁称号%'`,
        )
        .changes,
  },
  {
    key: "daily-stats-double-encoded-hours",
    why:
      "早期版本在冲突分支里对 `hour_histogram` 又手动 JSON.stringify 了一次，" +
      "存进去的是一个「装着数组的字符串」。读的那一侧现在有兜底（不是数组就当全 0），" +
      "**于是那几天的小时分布被静默当成了零** —— 而数据其实还在，只是包了两层。" +
      "解开一层就能完整还原",
    run: (tx) => {
      const rows = tx
        .all<{ rowid: number; h: string }>(
          sql`SELECT rowid AS rowid, hour_histogram AS h FROM daily_stats
              WHERE hour_histogram LIKE '"%'`,
        )
        .filter((r) => typeof r.h === "string");

      let fixed = 0;
      for (const row of rows) {
        let inner: unknown;
        try {
          inner = JSON.parse(row.h);
        } catch {
          continue;
        }
        // 双重编码的表现是：解一层之后拿到的还是字符串
        if (typeof inner !== "string") continue;

        let arr: unknown;
        try {
          arr = JSON.parse(inner);
        } catch {
          continue;
        }

        /*
         * 只有**确实是 24 个数字**才写回去。
         *
         * 形状不对就不动：一次猜错的批量写入比坏数据本身糟得多，
         * 因为坏数据至少还看得出是坏的。
         */
        if (!Array.isArray(arr) || arr.length !== 24) continue;
        if (!arr.every((v) => typeof v === "number" && Number.isFinite(v))) continue;

        tx.run(
          sql`UPDATE daily_stats SET hour_histogram = ${JSON.stringify(arr)} WHERE rowid = ${row.rowid}`,
        );
        fixed++;
      }
      return fixed;
    },
  },
  {
    key: "daily-stats-drift",
    why:
      "统计原来是累加的：消息写进去之后、统计落库之前那一轮失败了，" +
      "重跑时消息因为主键冲突被跳过，那几条**永远不会被计入**。" +
      "线上对照下来 `daily_stats` 比 `messages` 少 26 条、14 个人对不上 —— " +
      "而榜单是按这张表排的。落库那一侧已经改成从消息表重算，" +
      "这一条把**历史上漏掉的**补回来。" +
      "后来又补了一条判定：**小时分布也要和条数对得上** —— " +
      "线上还剩 4 行是「条数全对、只有直方图是短的」，" +
      "那种行光比计数永远发现不了",
    run: (tx) => {
      /*
       * **从消息那一侧扫起**，不是从 daily_stats 扫起。
       *
       * 第一版是 `FROM daily_stats LEFT JOIN messages`，
       * 它只看得见「已经有统计行、但数字不对」的那些 ——
       * 而**统计行压根没写过**的那种漏掉了，
       * 那恰恰是这个 bug 最彻底的形态：消息进来了，统计一次都没落。
       *
       * 线上验证时正是这样：14 行修好之后还剩 1 个人对不上，
       * 查下来他那一天根本没有统计行。「修好了」和「全修好了」
       * 差的就是这一条 JOIN 的方向。
       *
       * 只重算**对不上的**，不全表重算：后者每次启动都要扫一遍
       * 45000 条，而且日志里永远看不出「这次到底有没有漂移」——
       * 一个每次都说「修了 3831 行」的修复，和没有修复一样没信息。
       *
       * ─────────────────────────────────────────
       * 直方图也要比 —— 只比计数会漏掉一整类
       * ─────────────────────────────────────────
       *
       * 第一版的 WHERE 只比三个计数列。线上因此漏掉 4 行：
       * messages 完全正确（78 = 78），榜单、积分、条数全对，
       * **只有小时分布是短的**（直方图加起来才 5）。
       *
       * 那种行没有任何征兆，是做补课页的节奏条时才对出来的：
       * 整群直方图合计 11,503，而消息 11,631。
       *
       * 教训是：**一个只比一半列的一致性检查，
       * 会让人以为另一半也检查过了**。
       *
       * json_valid 兜住早期双重编码的行 —— 那种行 sum 出来是 0，
       * 一样会被挑出来重算，正是想要的结果；
       * 直方图为 NULL 时 json_each 一行都不返回，所以兜底写成 -1，
       * 否则「没有直方图」会被当成「0 条」而与真实条数比出相等。
       */
      const drifted = tx.all<{ wxId: string; convId: string; date: string }>(
        sql`SELECT m.wx_id AS wxId, m.conv_id AS convId, m.date AS date
            FROM (
              SELECT sender_wx_id AS wx_id, conv_id,
                     date(ts / 1000, 'unixepoch', '+8 hours') AS date,
                     count(*) AS n, sum(is_quality) AS q, sum(length) AS c
              FROM messages WHERE is_send = 0
              GROUP BY wx_id, conv_id, date
            ) m
            LEFT JOIN daily_stats s
              ON s.wx_id = m.wx_id AND s.conv_id = m.conv_id AND s.date = m.date
            WHERE s.wx_id IS NULL
               OR s.messages != m.n
               OR s.quality_messages != coalesce(m.q, 0)
               OR s.chars_total != coalesce(m.c, 0)
               -- 直方图也要比（为什么见上面那段注释）
               OR coalesce(
                    (SELECT sum(value) FROM json_each(s.hour_histogram)
                      WHERE json_valid(s.hour_histogram)),
                    -1
                  ) != m.n`,
      );

      let fixed = 0;
      for (const row of drifted) {
        const agg = tx.all<{ n: number; q: number; c: number; first: number; last: number }>(
          sql`SELECT count(*) AS n, sum(is_quality) AS q, sum(length) AS c,
                     min(ts) AS first, max(ts) AS last
              FROM messages
              WHERE conv_id = ${row.convId} AND sender_wx_id = ${row.wxId}
                AND is_send = 0
                AND date(ts / 1000, 'unixepoch', '+8 hours') = ${row.date}`,
        )[0];

        // 一条消息都没有的那几行是别的来源留下的，不动它
        if (!agg || !agg.n) continue;

        const hourRows = tx.all<{ h: number; n: number }>(
          sql`SELECT CAST(strftime('%H', ts / 1000, 'unixepoch', '+8 hours') AS INTEGER) AS h,
                     count(*) AS n
              FROM messages
              WHERE conv_id = ${row.convId} AND sender_wx_id = ${row.wxId}
                AND is_send = 0
                AND date(ts / 1000, 'unixepoch', '+8 hours') = ${row.date}
              GROUP BY h`,
        );
        const hours = new Array(24).fill(0);
        for (const h of hourRows) hours[h.h] = Number(h.n);

        /*
         * upsert —— 统计行可能**根本不存在**（那正是最彻底的那种漏）。
         * 只 UPDATE 的话，`changes` 是 0，而 fixed 却加了一，
         * 于是日志说修好了、数字还是错的。
         */
        tx.run(
          sql`INSERT INTO daily_stats
                (wx_id, conv_id, date, messages, quality_messages, chars_total,
                 first_msg_at, last_msg_at, hour_histogram, updated_at)
              VALUES (${row.wxId}, ${row.convId}, ${row.date},
                      ${Number(agg.n)}, ${Number(agg.q ?? 0)}, ${Number(agg.c ?? 0)},
                      ${Number(agg.first)}, ${Number(agg.last)},
                      ${JSON.stringify(hours)}, ${Date.now()})
              ON CONFLICT(wx_id, conv_id, date) DO UPDATE SET
                messages = excluded.messages,
                quality_messages = excluded.quality_messages,
                chars_total = excluded.chars_total,
                first_msg_at = excluded.first_msg_at,
                last_msg_at = excluded.last_msg_at,
                hour_histogram = excluded.hour_histogram,
                updated_at = excluded.updated_at`,
        );
        fixed++;
      }
      return fixed;
    },
  },
];

/** 每条修复的说明 —— 测试要求每条都写得出为什么 */
export const REPAIR_REASONS = REPAIRS.map((r) => ({ key: r.key, why: r.why }));

export function runRepairs(tx: typeof db = db): RepairResult[] {
  return REPAIRS.map((repair) => ({ key: repair.key, fixed: repair.run(tx) }));
}
