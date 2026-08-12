import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { featureEnabled } from "@/lib/flags/server";
import { createReplyAs } from "@/lib/forum/write";

export const dynamic = "force-dynamic";

/**
 * 回一个帖。
 *
 * 走的是网页那条同一段实现（`createReplyAs`）—— 锁帖判定、匿名规则、
 * 敏感词、回复频率限制全在里面。看不见的帖子回不了，
 * 而且错误信息和「不存在」一致，不泄露存在性。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, ["forum:write"]);
  if (!auth.ok) return auth.response;

  /*
   * 功能开关也要过。
   *
   * 论坛模块关掉之后，网页那边 `requireFeature` 会 404 ——
   * 而 API 这条路如果不判，就成了**一个绕过开关的后门**：
   * 站长以为关掉了，实际上带令牌照样读得到、发得出去。
   *
   * （`canReadForum` 管的是「对访客开不开」，API 这条路上没有访客 ——
   * 有效令牌背后一定是一个真实账号，所以那一条在这里恒真。）
   */
  if (!featureEnabled("forum", auth.caller.user)) {
    return apiError(404, "not_found", "论坛模块没有开");
  }

  let body: { content?: unknown; anonymous?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError(400, "bad_json", "请求体不是合法的 JSON");
  }
  if (typeof body.content !== "string") {
    return apiError(400, "bad_request", "要有 content 字段");
  }

  const { id } = await params;
  const result = await createReplyAs(auth.caller.user, {
    postId: id,
    content: body.content,
    anonymous: body.anonymous === true,
  });

  if (!result.ok) return apiError(400, "rejected", result.error ?? "回不上去");
  return NextResponse.json({ ok: true, reply_id: result.replyId, note: result.note ?? null });
}
