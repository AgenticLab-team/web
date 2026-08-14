import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { groupCatchup, hasEnoughToShow } from "@/lib/onboarding/catchup";
import { visibleGroupsFor } from "@/lib/queries/visibility";

export const dynamic = "force-dynamic";

/**
 * 新人补课包：群名、常驻成员、活跃时段、这几天发生了什么。
 *
 * ─────────────────────────────────────────
 * 它把群的画像一次端出来，所以门槛是「登录」而不是「公开」
 * ─────────────────────────────────────────
 *
 * 群列表属于隐私，而这一份比群列表说得更多 ——
 * 谁常在、几点最热闹、最近在聊什么。
 *
 * `hasEnoughToShow` 那一步不能省：一个刚同步了几十条消息的群，
 * 补课包里全是「暂无」。给一个空壳比不给更糟 ——
 * 它让人以为这个群没什么人说话。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["me:read"]);
  if (!auth.ok) return auth.response;

  const { user } = auth.caller;
  const packs = visibleGroupsFor(user)
    .map((g) => groupCatchup(user, g.convId))
    .filter((p): p is NonNullable<typeof p> => p !== null && hasEnoughToShow(p));

  return NextResponse.json({ groups: packs });
}
