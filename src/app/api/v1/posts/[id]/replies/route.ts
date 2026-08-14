import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { forumGate } from "@/lib/forum/api-gate";
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

  /* 功能开关也要过 —— 不判的话令牌就是一条绕过开关的后门，见 forum/api-gate.ts */
  const gate = forumGate(auth.caller.user);
  if (gate) return gate;

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
