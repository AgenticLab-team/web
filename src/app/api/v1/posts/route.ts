import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { featureEnabled } from "@/lib/flags/server";
import { eq } from "drizzle-orm";

import { buildViewerContext } from "@/lib/forum/context";
import { db } from "@/lib/db";
import { boards } from "@/lib/db/schema";
import { listPosts } from "@/lib/forum/queries";
import { createPostAs } from "@/lib/forum/write";

export const dynamic = "force-dynamic";

/**
 * 帖子列表 / 发帖。
 *
 * ═════════════════════════════════════════
 * 两个动作都走网页那条**同一段实现**
 * ═════════════════════════════════════════
 *
 * 读走 `listPosts`（可见性收口、按作者筛时排除匿名帖都在里面），
 * 写走 `createPostAs`（版块权限、等级门槛、匿名规则、必填标签、
 * 敏感词、发帖频率限制全在里面）。
 *
 * 令牌**不是一条绕开规则的近路** —— 另写一份「API 版的发帖」
 * 是这里唯一真正危险的做法：两份规则迟早分叉，
 * 而分叉的方向永远是 API 那份更宽松。
 */
export async function GET(request: Request) {
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

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 50);
  /*
   * 按版块筛要的是 board **id**，而外面给的是 key（人看得懂的那个）。
   * 查不到就当没筛 —— 报错的话，一个拼错版块名的请求会拿到
   * 「版块不存在」，而那等于让人可以枚举版块。
   */
  const boardKey = url.searchParams.get("board");
  const board = boardKey
    ? db.select({ id: boards.id }).from(boards).where(eq(boards.key, boardKey)).get()
    : undefined;

  const posts = listPosts(buildViewerContext(auth.caller.user), {
    boardId: board?.id,
    limit,
  });
  return NextResponse.json({
    posts: posts.map((p) => ({
      id: p.id,
      title: p.title,
      board: p.boardKey,
      author: p.anonymous ? null : p.authorName,
      replies: p.replyCount,
      created_at: p.createdAt,
    })),
  });
}

export async function POST(request: Request) {
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

  let body: { board?: unknown; title?: unknown; content?: unknown; anonymous?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError(400, "bad_json", "请求体不是合法的 JSON");
  }

  if (typeof body.board !== "string" || typeof body.title !== "string" || typeof body.content !== "string") {
    return apiError(400, "bad_request", "要有 board、title、content 三个字符串字段");
  }

  const result = await createPostAs(auth.caller.user, {
    boardKey: body.board,
    title: body.title,
    content: body.content,
    anonymous: body.anonymous === true,
  });

  if (!result.ok) return apiError(400, "rejected", result.error ?? "发不出去");
  return NextResponse.json({ ok: true, post_id: result.postId, note: result.note ?? null });
}
