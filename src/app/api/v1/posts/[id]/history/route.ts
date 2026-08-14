import { NextResponse } from "next/server";

import { desc, eq } from "drizzle-orm";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { forumGate } from "@/lib/forum/api-gate";
import { db } from "@/lib/db";
import { postRevisions } from "@/lib/db/schema";
import { buildViewerContext } from "@/lib/forum/context";
import { getPost } from "@/lib/forum/queries";

export const dynamic = "force-dynamic";

/**
 * 一篇帖子改过几次、每次改了什么。
 *
 * ═════════════════════════════════════════
 * 先判**能不能看这篇帖子**，再给历史
 * ═════════════════════════════════════════
 *
 * 直接按 post_id 查 `post_revisions` 是最自然的写法，也是错的：
 * 那张表上没有可见性，于是一篇私密版块里的帖子，
 * 它的**每一版正文**都能通过这条接口读出来。
 *
 * 而这种泄露完全没有症状 —— 帖子本身照常 404。
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, ["forum:read"]);
  if (!auth.ok) return auth.response;

  const gate = forumGate(auth.caller.user);
  if (gate) return gate;

  const { id } = await params;
  const viewer = buildViewerContext(auth.caller.user);
  if (!getPost(viewer, id)) return apiError(404, "not_found", "没有这篇帖子");

  const revisions = db
    .select({
      id: postRevisions.id,
      title: postRevisions.title,
      content: postRevisions.content,
      changeNote: postRevisions.changeNote,
      createdAt: postRevisions.createdAt,
      editorId: postRevisions.editorId,
    })
    .from(postRevisions)
    .where(eq(postRevisions.postId, id))
    .orderBy(desc(postRevisions.createdAt))
    .all();

  return NextResponse.json({ revisions });
}
