import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { nekobot } from "@/lib/nekobot/client";

/**
 * 镜像完整性对账。
 *
 * ─────────────────────────────────────────
 * 「归档缺了一段」有两种完全不同的原因
 * ─────────────────────────────────────────
 *
 * 一种是**本地漏了**：同步断过、游标跳过去了 —— 这种能补，
 * 而且必须补，因为上游随时可能清掉历史。
 *
 * 另一种是**上游本来就没有**：那几天机器人没在采集 ——
 * 这种补不了，再跑多少次同步都是白跑。
 *
 * 两者在站里长得一模一样：按天回看都是空的，页面都只会说
 * 「这天没有消息」。而它们要做的事完全相反。
 *
 * ─────────────────────────────────────────
 * 这个判断此前做不了
 * ─────────────────────────────────────────
 *
 * `scripts/verify.ts` 只查一个写死的群，比的是七日榜、FTS 和日统计，
 * **从来没有比过「这个群本地有多少条、上游有多少条」**。
 * 也就是说，本地少了一大段这件事，没有任何东西会发现。
 *
 * 线上第一次跑出来的结果：11,631 = 11,631，逐群一条不差 ——
 * 而 2026-07-15 ~ 07-29 那 15 天上游的 total 也是 0。
 * 结论是那段是**上游自己的空白**，不是本地漏了，补不回来。
 *
 * ─────────────────────────────────────────
 * 不存结果，按需跑
 * ─────────────────────────────────────────
 *
 * 存一份「上次对账通过」的话，它会随着时间慢慢变成谎话 ——
 * 而对账恰恰是用来识破谎话的。这东西要么现在问上游，要么别问。
 */

export interface MirrorRow {
  convId: string;
  name: string;
  local: number;
  /** 上游报的总数。问不到时是 null —— 不是 0 */
  upstream: number | null;
  /** 上游 − 本地。正数 = 本地少了 */
  delta: number | null;
  status: "ok" | "behind" | "ahead" | "unknown";
}

export interface MirrorAudit {
  rows: MirrorRow[];
  checkedAt: number;
  /** 本地少了消息的群 */
  behind: number;
  /** 没问到上游的群 */
  unknown: number;
}

/** 上游那一侧只需要一个数 —— 注入进来是为了能在没有网的地方测 */
export type TotalFetcher = (convId: string) => Promise<number>;

const upstreamTotal: TotalFetcher = async (convId) => {
  /*
   * `limit: 1` —— 要的只是 `total`。
   *
   * 不限时间范围：这里问的是「这个群上游一共有多少条」，
   * 加了时间窗就变成了另一个问题，而两边的窗口差一秒就会对不上。
   */
  const page = await nekobot.messages({ conv_id: convId, limit: 1, include_self: false });
  return page.total;
};

/**
 * 判定一行。
 *
 * ─────────────────────────────────────────
 * 「本地比上游多」不是错，别报成错
 * ─────────────────────────────────────────
 *
 * 上游会裁剪历史，而本地是镜像 —— 本地留着上游已经清掉的老消息
 * 是这个站存在的理由之一。把它标成红色的话，
 * 每次上游一裁剪，这一页就全红，然后没有人会再看它。
 *
 * 真正要报的只有一个方向：**本地比上游少**。
 */
export function classify(local: number, upstream: number | null): MirrorRow["status"] {
  if (upstream === null) return "unknown";
  if (upstream > local) return "behind";
  if (upstream < local) return "ahead";
  return "ok";
}

export async function auditMirror(
  fetcher: TotalFetcher = upstreamTotal,
  now = Date.now(),
): Promise<MirrorAudit> {
  const groups = db.all<{ convId: string; name: string; local: number }>(
    sql`SELECT g.conv_id AS convId, g.name AS name,
               (SELECT count(*) FROM messages m WHERE m.conv_id = g.conv_id) AS local
        FROM groups g
        WHERE g.sync_enabled = 1
        ORDER BY local DESC`,
  );

  const rows: MirrorRow[] = [];

  for (const g of groups) {
    let upstream: number | null = null;
    try {
      upstream = await fetcher(g.convId);
    } catch {
      /*
       * 问不到就是 null，**不是 0**。
       *
       * 当成 0 的话，上游一挂，这一页会说「每个群本地都比上游多」——
       * 一切正常。那比报错糟得多。
       */
      upstream = null;
    }

    const local = Number(g.local ?? 0);
    rows.push({
      convId: g.convId,
      name: g.name,
      local,
      upstream,
      delta: upstream === null ? null : upstream - local,
      status: classify(local, upstream),
    });
  }

  return {
    rows,
    checkedAt: now,
    behind: rows.filter((r) => r.status === "behind").length,
    unknown: rows.filter((r) => r.status === "unknown").length,
  };
}
