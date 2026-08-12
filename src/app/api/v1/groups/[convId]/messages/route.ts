import { NextResponse } from "next/server";

import { authenticate, apiError } from "@/lib/api-tokens/auth";
import { sendToGroup } from "@/lib/api-tokens/send";

export const dynamic = "force-dynamic";

/**
 * 往一个群发一条文本。
 *
 * ```
 * POST /api/v1/groups/<conv_id>/messages
 * Authorization: Bearer al_…
 * {"text": "大家好"}
 * ```
 *
 * ⚠️ 发出去的消息**一定会带一行代发署名** —— 见 `lib/api-tokens/rules.ts`。
 * 这不是可选项：消息由机器人账号发出，不署名的话群里没有人知道是谁说的。
 *
 * 所有检查（授权、在不在这个群、内容、限流、留痕）都在 `sendToGroup` 里，
 * 这个文件只负责把 HTTP 翻译成那次调用 —— 网页那个入口调的是同一个函数。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ convId: string }> },
) {
  const auth = await authenticate(request, ["groups:send"]);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_json", "请求体不是合法的 JSON");
  }

  const { convId } = await params;
  const result = await sendToGroup({
    user: auth.caller.user,
    tokenId: auth.caller.tokenId,
    convId: decodeURIComponent(convId),
    text: (body as { text?: unknown } | null)?.text,
  });

  if (!result.ok) {
    return apiError(
      result.status,
      result.status === 429 ? "rate_limited" : "send_failed",
      result.error,
      result.retryAfterSeconds
        ? { "Retry-After": String(result.retryAfterSeconds) }
        : undefined,
    );
  }

  return NextResponse.json({ ok: true, msg_svr_id: result.msgSvrId });
}
