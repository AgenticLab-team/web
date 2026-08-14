import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { myModerationRecord } from "@/lib/forum/appeals-queries";

export const dynamic = "force-dynamic";

/**
 * 我身上的处罚，以及我提过的申诉。
 *
 * ─────────────────────────────────────────
 * 被处罚的人**必须**能看到这一页
 * ─────────────────────────────────────────
 *
 * 一个不知道自己被禁言了的人，会以为是网站坏了 ——
 * 他会一直重试，然后放弃。而处罚的目的从来不是让人消失。
 *
 * 所以这条接口不判「你有没有权限看处罚」：处罚是对他做的，
 * 他当然有权知道是什么、为什么、到什么时候。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["me:read"]);
  if (!auth.ok) return auth.response;
  return NextResponse.json(myModerationRecord(auth.caller.user.id));
}
