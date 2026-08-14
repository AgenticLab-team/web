import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { param } from "@/lib/api-tokens/route-helpers";
import { messagesOfDay } from "@/lib/forum/convert-source";
import { dayCurve } from "@/lib/messages/day-curve";
import { resolveOrder } from "@/lib/messages/archive-rules";
import { visibleGroupsFor } from "@/lib/queries/visibility";
import { todayKey } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * 按天回看：某一天群里说了什么。
 *
 * ═════════════════════════════════════════
 * 这是站里数据最多的一个面
 * ═════════════════════════════════════════
 *
 * 四万多条消息。所以它按天切片，而不是给一条无限的流 ——
 * 一条无限流在终端里意味着「往上翻」永远翻不到头，
 * 而人真正想问的是「那天到底说了什么」。
 *
 * 曲线（每小时多少条）和消息一起给：终端里那是同一屏上的两块，
 * 分两次请求的话会先闪一个没有曲线的版本。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["groups:read"]);
  if (!auth.ok) return auth.response;

  const { user } = auth.caller;
  const convId = param(request, "conv_id");
  if (!convId) {
    /*
     * 不传群就把可见的群列出来，而不是报错。
     *
     * 终端第一次进这一屏时手上没有 conv_id —— 让它先撞一个 400
     * 再去调 `/groups` 是多一次往返，而这里本来就知道答案。
     */
    return NextResponse.json({ groups: visibleGroupsFor(user), messages: null });
  }

  const date = param(request, "date") ?? todayKey();
  const order = resolveOrder(param(request, "order"));
  const day = messagesOfDay(user, convId, date, {
    order,
    page: param(request, "page") ?? 1,
  });

  /*
   * 「不在这个群」和「这天没有消息」给同一个 404。
   *
   * 分开说的话，一个不在群里的人能靠这条接口试出
   * 「这个群那天有没有人说话」—— 而群的存在本身就是隐私。
   */
  if (!day) return apiError(404, "not_found", "没有这个群，或者你不在里面");

  return NextResponse.json({
    date,
    conv_id: convId,
    order,
    curve: dayCurve(convId, date),
    ...day,
  });
}
