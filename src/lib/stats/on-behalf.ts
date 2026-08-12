import "server-only";

import { and, eq, isNotNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { apiSends, users } from "@/lib/db/schema";

/**
 * 这个群里哪些消息是代发的：`msg_svr_id` → 那个成员的 `wx_id`。
 *
 * ─────────────────────────────────────────
 * 为什么整轮查一次
 * ─────────────────────────────────────────
 *
 * 代发很少（一天几十条封顶，额度就那么多），而一轮同步要处理几千条消息。
 * 逐条去查等于给每条消息加一次 join —— 为一件几乎不发生的事
 * 让最热的那条路慢下来。
 *
 * `ok = 1`：只有真的发出去了才算。失败的代发在表里也留着
 * （限流要数它们），但群里根本没出现过那条消息，
 * 拿它去认领一条真实消息是认不到的 —— 不过写清楚比依赖巧合好。
 *
 * `msg_svr_id` 非空：上游偶尔会成功但不回 id，那种记录没法和消息对上。
 */
export function onBehalfAuthors(convId: string): Map<string, string> {
  const rows = db
    .select({ msgSvrId: apiSends.msgSvrId, wxId: users.wxId })
    .from(apiSends)
    .innerJoin(users, eq(users.id, apiSends.userId))
    .where(
      and(eq(apiSends.convId, convId), eq(apiSends.ok, true), isNotNull(apiSends.msgSvrId)),
    )
    .all();

  const out = new Map<string, string>();
  for (const row of rows) {
    // wx_id 可能是空的（账号还没绑微信）—— 那种认不回去，只能算机器人的
    if (row.msgSvrId && row.wxId) out.set(row.msgSvrId, row.wxId);
  }
  return out;
}
