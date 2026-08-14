import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { buildDigest } from "@/lib/queries/digest";
import { unreadCount } from "@/lib/forum/notify";
import { checkinStatus } from "@/lib/points/checkin";
import { visibleGroupIds } from "@/lib/queries/visibility";

export const dynamic = "force-dynamic";

/**
 * 首页摘要：这几天群里发生了什么、我有什么待办。
 *
 * ═════════════════════════════════════════
 * 不要求任何 scope，但**按令牌能看到的东西自己收敛**
 * ═════════════════════════════════════════
 *
 * 一个只有 `me:read` 的令牌调这条，拿到的是打卡状态和未读数，
 * 群摘要那一块整个不出现 —— 而不是报 403。
 *
 * 理由：首页在终端里是**落地屏**。它 403 的话，一个权限窄的令牌
 * 进来看到的第一样东西就是一屏错误，而他其实什么也没做错。
 *
 * 少一块和报一次错的区别在于：前者他还能继续用，后者他会以为登录坏了。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, []);
  if (!auth.ok) return auth.response;

  const { user, scopes } = auth.caller;
  const body: Record<string, unknown> = {};

  if (scopes.includes("me:read")) {
    body.me = {
      name: user.siteNickname ?? user.wxNickname ?? null,
      points: user.points,
      checkin: checkinStatus(user),
    };
  }

  if (scopes.includes("notifications:read")) {
    body.unread = unreadCount(user.id);
  }

  if (scopes.includes("groups:read")) {
    /*
     * 群摘要按**可见的群**算。`buildDigest` 收 convIds 而不是自己去查，
     * 和榜单那条同一个理由：让调用点显式地把范围传进来，
     * 忘了传的结果是空摘要，不是全站摘要。
     */
    body.digest = buildDigest(user, visibleGroupIds(user));
  }

  return NextResponse.json(body);
}
