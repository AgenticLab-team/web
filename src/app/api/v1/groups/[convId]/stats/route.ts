import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { nekobot } from "@/lib/nekobot/client";
import { hiddenWxIds } from "@/lib/privacy/queries";
import { assertGroupAccess } from "@/lib/queries/visibility";

export const dynamic = "force-dynamic";

/**
 * 一个群的统计：发言榜 + 活跃度分布。
 *
 * ═════════════════════════════════════════
 * 隐私开关在这条路上同样要生效
 * ═════════════════════════════════════════
 *
 * 榜单本身是公开的（站长定过：「未登录访客和其他人还是可以看见大榜单的」），
 * 但**一个人可以关掉「出现在榜单上」**。上游不知道这件事 ——
 * 它按聊天记录算，算出来的是全部人。
 *
 * 所以这里拿到上游结果之后要过一遍站内的隐私开关。
 * 不过的话，一个人在网页上把自己藏了，而带令牌调这条接口照样能看见他 ——
 * 那等于那个开关不存在，而他以为它存在。
 */

/** 一次最多给多少行。上游更宽，但这里是开放接口，压低一点 */
const MAX_LIMIT = 100;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ convId: string }> },
) {
  const auth = await authenticate(request, ["groups:read"]);
  if (!auth.ok) return auth.response;

  const convId = decodeURIComponent((await params).convId);
  if (!assertGroupAccess(auth.caller.user, convId)) {
    return apiError(404, "not_found", "没有这个群，或者你不在里面");
  }

  const url = new URL(request.url);
  const days = Math.min(Math.max(1, Number(url.searchParams.get("days") ?? 30) || 30), 365);
  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20), MAX_LIMIT);

  try {
    /*
     * 两个上游调用并行。串行的话这条接口的延迟是两次往返之和 ——
     * 而它们之间没有任何依赖关系。
     */
    const [board, activity] = await Promise.all([
      nekobot.leaderboard(convId, { days, limit }),
      nekobot.activity(convId, { days, by: "day" }),
    ]);

    /*
     * 过一遍隐私开关。
     *
     * `hiddenWxIds(viewer)` 给的是关掉了对应开关的那批人 ——
     * 和网页榜单用的是同一个函数，所以两边不会说不同的话。
     * 传 viewer 进去也保留了「站长能看见全部」这条既有行为。
     */
    const hidden = hiddenWxIds(auth.caller.user);
    const hiddenBoard = new Set(hidden.leaderboard);

    return NextResponse.json({
      conv_id: convId,
      days,
      leaderboard: board.leaderboard
        .filter((r) => !hiddenBoard.has(r.wx_id))
        .map((r) => ({
          wx_id: r.wx_id,
          name: r.name ?? null,
          messages: r.messages ?? 0,
          quality_messages: r.quality_messages ?? 0,
        })),
      /*
       * 活跃度是**整个群按时段汇总**的，不分人 ——
       * 所以「在主页上显示我一般什么时候说话」那个开关在这里不适用：
       * 这份数据里本来就没有任何一个人的影子。
       */
      activity: activity.buckets,
      /*
       * 明说过滤过。
       *
       * 不说的话，调用方拿两个群的数字做对比会得出错误结论 ——
       * 他不知道其中一个群有五个人把自己藏了。
       */
      note: "关掉了「出现在榜单上」的成员不会出现在这里",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return apiError(502, "upstream_error", `取不到统计：${detail}`);
  }
}
