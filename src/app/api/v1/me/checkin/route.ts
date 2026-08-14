import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { checkinStatus, performCheckin } from "@/lib/points/checkin";
import { clientIp } from "@/lib/request";

export const dynamic = "force-dynamic";

/**
 * 打卡。
 *
 * ═════════════════════════════════════════
 * 已经打过的那一次**不报错**
 * ═════════════════════════════════════════
 *
 * 这一条是给脚本用的，而脚本会重试 —— 网络抖一下、终端断线重连，
 * 同一个动作发两次是常态。
 *
 * 第二次回 400 的话，一个每天早上跑一次的定时脚本会在
 * 「昨天已经成功、今天网络慢重试了一次」那天报警，
 * 而它其实完全正常。
 *
 * 所以第二次回的是同一份状态 —— **幂等**。真正的失败
 * （账号被封、积分系统关了）仍然是 400。
 */
export async function POST(request: Request) {
  const auth = await authenticate(request, ["me:write"]);
  if (!auth.ok) return auth.response;

  const { user } = auth.caller;
  const before = checkinStatus(user);
  if (before.checkedToday) {
    return NextResponse.json({ ok: true, already: true, checkin: before });
  }

  /*
   * IP 传下去：打卡是发积分的动作，而积分是可以换东西的。
   * 那一层按 IP 做异常检测，不传的话它看到的是一批「没有来源」的打卡。
   */
  const result = performCheckin(user, clientIp(request));
  if (!result.ok) {
    return NextResponse.json({ error: { code: "rejected", message: result.error } }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    already: false,
    awarded: result.awarded ?? 0,
    streak: result.streak,
    /* 撞上每日发行上限时一分没拿到 —— 不说的话人会以为打卡没生效 */
    capped_out: result.cappedOut === true,
    leveled_up: result.leveledUp ?? null,
    checkin: checkinStatus(user),
  });
}
