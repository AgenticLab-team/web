import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { evaluateEligibility, type Rule } from "@/lib/activities/eligibility";
import { getActivity, listApplications } from "@/lib/activities/queries";
import { computeStatsFor } from "@/lib/activities/stats";
import { featureEnabled } from "@/lib/flags/server";

export const dynamic = "force-dynamic";

/**
 * 一个活动的详情、我的报名状态，以及**我差在哪**。
 *
 * ═════════════════════════════════════════
 * 资格要逐条给，不能只给一个「不符合条件」
 * ═════════════════════════════════════════
 *
 * 只说不符合的话，人不知道该去补哪一样 —— 而这套资格引擎
 * 存在的全部意义就是让门槛是**可行动的**：
 * 「还差 120 积分」和「打卡还差 3 天」是两件完全不同的事，
 * 前者他今天就能做到，后者做不到。
 *
 * 所以 `failures` 里每一条都带一句人话，终端原样显示。
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, ["community:read"]);
  if (!auth.ok) return auth.response;

  if (!featureEnabled("events", auth.caller.user)) {
    return apiError(404, "not_found", "活动模块没有开");
  }

  const { user } = auth.caller;
  const { id } = await params;
  const activity = getActivity(id);
  if (!activity) return apiError(404, "not_found", "没有这个活动");

  /*
   * 没有 wx_id 的账号算不出统计（资格是按群里的发言算的）。
   * 那时候给 null 而不是「不符合」—— 后者是一个他无法理解的结论。
   */
  const stats = user.wxId ? computeStatsFor(user.wxId) : null;
  const eligibility = stats
    ? evaluateEligibility((activity.eligibility as Rule | null) ?? null, stats)
    : null;

  /*
   * 按 (活动, 人) 精确查，而不是把整张报名表拉回来再 find ——
   * 一个几百人报名的活动，后者是把所有人的报名信息读进内存，
   * 而调用方只该看得到他自己那一条。
   */
  const mine = listApplications({ activityId: id, userId: user.id, limit: 1 })[0] ?? null;

  return NextResponse.json({
    activity,
    eligibility,
    my_application: mine,
  });
}
