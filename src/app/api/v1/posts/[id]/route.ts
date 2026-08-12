import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { featureEnabled } from "@/lib/flags/server";
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
