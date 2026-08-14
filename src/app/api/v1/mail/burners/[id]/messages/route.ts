import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { getOwnedBurner, listBurnerMessages } from "@/lib/mail/burner";
import { messagePayload } from "@/lib/mail/api-view";

export const dynamic = "force-dynamic";

/**
 * 这个箱子收到的信。
 *
 * `?since=<毫秒时间戳>` 做增量拉取 —— 没有它的话，脚本每次都要
 * 把全部邮件拉下来自己比对，而这条路上的邮件带着正文。
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, ["mail:burner"]);
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  const box = getOwnedBurner(id, { userId: auth.caller.user.id, tokenId: auth.caller.tokenId });
  if (!box) return apiError(404, "not_found", "没有这个箱子，或者它不是这把令牌开的");

  const raw = new URL(request.url).searchParams.get("since");
  const since = raw ? Number(raw) : undefined;
  if (raw && !Number.isFinite(since)) {
    return apiError(400, "bad_since", "since 要是毫秒时间戳");
  }

  const messages = listBurnerMessages(box.id, { since });
  return NextResponse.json({
    address: box.address,
    expires_at: box.expiresAt,
    messages: messages.map(messagePayload),
  });
}
