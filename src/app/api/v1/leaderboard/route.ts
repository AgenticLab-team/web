import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { paging, param } from "@/lib/api-tokens/route-helpers";
import { getLeaderboard, getMyRank } from "@/lib/queries/leaderboard";
import { visibleGroupIds } from "@/lib/queries/visibility";

export const dynamic = "force-dynamic";

/**
 * 排行榜。
 *
 * ═════════════════════════════════════════
 * `convIds` **必须**传，而且不能有默认值
 * ═════════════════════════════════════════
 *
 * `getLeaderboard` 那边刻意没给默认值，理由写在它头上：
 * 有默认值就一定会有某个调用点忘了传，于是把全站数据
 * 泄露给只在两个群的人。忘了传的结果是空榜，不是全量榜。
 *
 * ─────────────────────────────────────────
 * 主排序是**高质量消息**，不是总条数
 * ─────────────────────────────────────────
 *
 * 按总条数排会让复读机上榜。判定口径（`{text,quote}` 且长度 ≥ 15）
 * 是从上游榜单反推出来的，`DEPLOY.md` 里那一节说得很清楚：
 * **机器人在群里报的排名和网站上的积分不能是两套数字。**
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, []);
  if (!auth.ok) return auth.response;

  const { user } = auth.caller;
  const { limit } = paging(request, 200);
  const convIds = visibleGroupIds(user);

  const options = {
    convIds,
    convId: param(request, "conv_id") ?? undefined,
    period: (param(request, "period") ?? undefined) as never,
    limit,
    viewer: user,
  };

  return NextResponse.json({
    entries: getLeaderboard(options),
    /* 「我在第几」单独给：一个不在前 50 的人，榜单本身对他没有信息量 */
    me: getMyRank(user, options),
  });
}
