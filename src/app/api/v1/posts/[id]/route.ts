import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { forumGate } from "@/lib/forum/api-gate";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { fromResult, readJson } from "@/lib/api-tokens/route-helpers";
import { editPost } from "@/lib/forum/actions";
import { buildViewerContext } from "@/lib/forum/context";
import { getPost, listReplies } from "@/lib/forum/queries";

export const dynamic = "force-dynamic";

/**
 * 一篇帖子和它的回复。
 *
 * 看不见的帖子和不存在的帖子**给同一个 404** ——
 * 分开说等于把「这个 id 存在」告诉了一个看不到它的人，
 * 而帖子 id 是可以枚举的。
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, ["forum:read"]);
  if (!auth.ok) return auth.response;

  const gate = forumGate(auth.caller.user);
  if (gate) return gate;

  const viewer = buildViewerContext(auth.caller.user);
  const { id } = await params;
  const post = getPost(viewer, id);
  if (!post) return apiError(404, "not_found", "没有这篇帖子");

  const replies = listReplies(viewer, post.raw.id);
  return NextResponse.json({
    id: post.raw.id,
    title: post.raw.title,
    content: post.raw.content,
    board: post.board.key,
    author: post.raw.anonymous ? null : post.authorName,
    created_at: post.raw.createdAt,
    replies: replies.map((r) => ({
      id: r.id,
      content: r.content,
      author: r.anonymous ? null : r.authorName,
      created_at: r.createdAt,
    })),
  });
}

/**
 * 编辑自己的帖子。
 *
 * ─────────────────────────────────────────
 * 标题和正文**都要传**，这一条是故意不做部分更新的
 * ─────────────────────────────────────────
 *
 * 编辑会留一版历史，而一版只改了标题的历史读起来是
 * 「正文变成空了」还是「正文没动」，取决于实现细节 ——
 * 而历史是用来事后判断「他改了什么」的，含糊的历史等于没有历史。
 *
 * 所以整篇替换：客户端先 GET 拿到当前内容，改完整份发回来。
 * 少打几个字节不值得让编辑历史变得不可信。
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, ["forum:write"]);
  if (!auth.ok) return auth.response;

  const gate = forumGate(auth.caller.user);
  if (gate) return gate;

  const parsed = await readJson<{ title?: unknown; content?: unknown; change_note?: unknown }>(
    request,
  );
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  if (typeof body.title !== "string" || typeof body.content !== "string") {
    return apiError(400, "bad_request", "要有 title 和 content —— 这条是整篇替换，见文档");
  }

  const { id } = await params;
  return runAsApiCaller(auth.caller, async () =>
    fromResult(
      await editPost({
        postId: id,
        title: body.title as string,
        content: body.content as string,
        changeNote: typeof body.change_note === "string" ? body.change_note : undefined,
      }),
    ),
  );
}
