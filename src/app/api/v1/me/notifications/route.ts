import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { paging } from "@/lib/api-tokens/route-helpers";
import { listNotifications, notificationCounts } from "@/lib/forum/notify";
import { parseFilter } from "@/lib/notifications/prefs";

export const dynamic = "force-dynamic";

/**
 * 通知列表。
 *
 * ─────────────────────────────────────────
 * 它归 `notifications:read` 而不是 `me:read`
 * ─────────────────────────────────────────
 *
 * 通知不是「一串标题」：@ 我的那条消息的正文、回复的摘要都在里面，
 * 也就是说它读得到**别人对我说的话**。
 *
 * 和「我有多少积分」放进同一个 scope 的话，一个只想看积分的脚本
 * 会顺手拿到我收到的每一条私下提及。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["notifications:read"]);
  if (!auth.ok) return auth.response;

  const { user } = auth.caller;
  const { limit } = paging(request, 100);
  const url = new URL(request.url);
  // 和网页那一页用同一个解析：分类名只在一处定义
  const filter = parseFilter(url.searchParams.get("f") ?? undefined);

  return NextResponse.json({
    counts: notificationCounts(user.id),
    notifications: listNotifications(user.id, limit, filter),
  });
}
