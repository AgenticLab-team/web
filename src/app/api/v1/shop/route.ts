import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { featureEnabled } from "@/lib/flags/server";
import { listItems, listOrders, ownedCounts } from "@/lib/shop/queries";

export const dynamic = "force-dynamic";

/**
 * 商店橱窗。
 *
 * ─────────────────────────────────────────
 * 「我买不买得起」和「我已经有几个」一起给
 * ─────────────────────────────────────────
 *
 * 不给的话，终端只能把所有商品都画成可买，人点进去才知道
 * 积分不够或者已经买过 —— 而后者尤其糟：限购的东西
 * 买第二次会被拒，那次拒绝在他看来像是系统出错。
 *
 * 余额是现成的（令牌背后那个账号），一起放进来。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["community:read"]);
  if (!auth.ok) return auth.response;

  const { user } = auth.caller;
  if (!featureEnabled("shop", user)) {
    return apiError(404, "not_found", "商店没有开");
  }

  return NextResponse.json({
    balance: user.points,
    items: listItems(),
    owned: ownedCounts(user.id),
    orders: listOrders({ userId: user.id, limit: 20 }),
  });
}
