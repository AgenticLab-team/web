import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { destroyBurner, getOwnedBurner } from "@/lib/mail/burner";
import { burnerPayload } from "@/lib/mail/api-view";

export const dynamic = "force-dynamic";

/** 这个箱子的状态与用量 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, ["mail:burner"]);
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  const box = getOwnedBurner(id, { userId: auth.caller.user.id, tokenId: auth.caller.tokenId });
  if (!box) return apiError(404, "not_found", "没有这个箱子，或者它不是这把令牌开的");

  return NextResponse.json(
    burnerPayload({
      id: box.id,
      address: box.address,
      displayAddress: `${box.localPart}@${box.domain}`,
      domain: box.domain,
      localPart: box.localPart,
      custom: box.custom,
      expiresAt: box.expiresAt ?? 0,
      messageCount: box.messageCount,
      unreadCount: box.unreadCount,
      createdAt: box.createdAt,
    }),
  );
}

/**
 * 提前销毁 ——「用完就扔」的那个扔。
 *
 * 销毁之后地址立刻可以被别人拿去用（部分唯一索引把 revoked 排除在外），
 * 所以这是一个**不可逆**的动作，正文一起清掉。
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, ["mail:burner"]);
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  const done = destroyBurner(id, { userId: auth.caller.user.id, tokenId: auth.caller.tokenId });
  if (!done) return apiError(404, "not_found", "没有这个箱子，或者它不是这把令牌开的");

  return new NextResponse(null, { status: 204 });
}
