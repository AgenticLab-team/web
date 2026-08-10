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
];

/** 每条修复的说明 —— 测试要求每条都写得出为什么 */
export const REPAIR_REASONS = REPAIRS.map((r) => ({ key: r.key, why: r.why }));

export function runRepairs(tx: typeof db = db): RepairResult[] {
  return REPAIRS.map((repair) => ({ key: repair.key, fixed: repair.run(tx) }));
}
