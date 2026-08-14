import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { paging } from "@/lib/api-tokens/route-helpers";
import { checkinStatus } from "@/lib/points/checkin";
import { listLedger } from "@/lib/points/ledger";
import { makeupState } from "@/lib/points/makeup";
import { getMyRank } from "@/lib/queries/leaderboard";
import { visibleGroupIds } from "@/lib/queries/visibility";

export const dynamic = "force-dynamic";

/**
 * 我的积分：余额、等级、流水、打卡状态、补签卡、赛季名次。
 *
 * ─────────────────────────────────────────
 * 一次给全，而不是四条接口
 * ─────────────────────────────────────────
 *
 * 终端里「积分」是**一屏**，而这一屏上的每一块都来自同一个人的
 * 同一时刻。拆成四条的话，客户端要发四个请求再拼起来 ——
 * 而那四个请求之间会发生打卡，于是屏幕上出现
 * 「今天已打卡」和「连续 0 天」并存的状态。
 *
 * 一次给全就没有这个窗口。代价是这条接口比别的重一点，
 * 而它一屏只调一次。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["me:read"]);
  if (!auth.ok) return auth.response;

  const { user } = auth.caller;
  const { limit } = paging(request, 100);

  const checkin = checkinStatus(user);
  const makeup = makeupState(user);
  /*
   * 名次要带上「他能看到哪些群」。
   *
   * `BoardOptions.convIds` 刻意没有默认值 —— 那个函数顶上写着理由：
   * 有默认值就一定会有某个调用点忘了传，于是把全站数据泄露给
   * 只在两个群的人。忘了传的结果是空榜，不是全量榜。
   */
  const rank = getMyRank(user, { convIds: visibleGroupIds(user) });

  return NextResponse.json({
    balance: user.points,
    checkin,
    makeup,
    rank,
    ledger: listLedger(user.id, limit),
  });
}
