import { NextResponse } from "next/server";

import { authenticate, apiError } from "@/lib/api-tokens/auth";
import { sendToGroup } from "@/lib/api-tokens/send";
import { assertGroupAccess } from "@/lib/queries/visibility";
import { searchMessages } from "@/lib/search/messages";

export const dynamic = "force-dynamic";

/**
 * 读这个群的消息。
 *
 * 走 `searchMessages` 而不是自己写一条 SQL —— 可见性收口、
 * 隐私开关（关掉「别人能搜到我的发言」的人不出现）都在那里面，
 * 而且**过滤是落在 SQL 里的**，不是查出来再 filter。
 * 另写一份必然漏掉其中一条。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ convId: string }> },
) {
  const auth = await authenticate(request, ["groups:read"]);
  if (!auth.ok) return auth.response;

  const convId = decodeURIComponent((await params).convId);
  /*
   * 先判在不在这个群里。不判的话，`searchMessages` 会返回空结果，
   * 而「这个群我不在」和「这个群没有匹配的消息」在调用方看来一模一样。
   */
  if (!assertGroupAccess(auth.caller.user, convId)) {
    return apiError(404, "not_found", "没有这个群，或者你不在里面");
  }

  const url = new URL(request.url);
  const result = searchMessages(auth.caller.user, {
    // 空查询 = 不按关键词筛，按时间倒序给最近的
    query: url.searchParams.get("q") ?? "",
    convId,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    limit: Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200),
  });

  return NextResponse.json({
    total: result.total,
    messages: result.hits.map((h) => ({
      id: h.id,
      sender: h.senderName,
      content: h.content,
      ts: h.ts,
      type: h.type,
    })),
  });
}

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
