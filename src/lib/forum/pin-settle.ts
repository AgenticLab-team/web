import "server-only";

import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";

import { db } from "@/lib/db";
import { posts } from "@/lib/db/schema";
import { notify } from "@/lib/forum/notify";

/**
 * 清理过期的置顶标记。
 *
 * 排序那边已经按 `pinned_until` 判过了，所以**过期的置顶不会真的排在前面** ——
 * 这个任务清的是那个还留着的布尔标记。
 *
 * 为什么值得单独跑一遍：后台的帖子列表、批量操作页、以及任何直接读
 * `pinned` 的地方，看到的都会是「置顶中」。一个和事实不符的标记，
 * 迟早会有人照着它做决定。
 */

export interface PinSettleResult {
  cleared: number;
  titles: string[];
}

export function settleExpiredPins(now = Date.now()): PinSettleResult {
  const expired = db
    .select({ id: posts.id, title: posts.title, authorId: posts.authorId })
    .from(posts)
    .where(
      and(
        eq(posts.pinned, true),
        isNotNull(posts.pinnedUntil),
        lte(posts.pinnedUntil, now),
        isNull(posts.deletedAt),
      ),
    )
    .all();

  for (const row of expired) {
    db.update(posts)
      .set({ pinned: false, pinnedUntil: null })
      .where(eq(posts.id, row.id))
      .run();

    /*
     * 告诉买的人它结束了。
     * 花了五百分买来的东西悄无声息地消失，下一次他不会再买 ——
     * 而且他会怀疑上一次到底有没有生效过。
     */
    notify({
      userId: row.authorId,
      type: "system",
      groupKey: `pin-expired:${row.id}`,
      title: "置顶已结束",
      body: row.title,
      link: `/forum/p/${row.id}`,
      refType: "post",
      refId: row.id,
    });
  }

  return { cleared: expired.length, titles: expired.map((r) => r.title) };
}
