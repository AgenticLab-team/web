"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { bookmarks, posts, reactions, replies, subscriptions } from "@/lib/db/schema";
import { REACTION_KINDS } from "@/lib/db/schema/forum";

import { buildViewerContext } from "./context";
import { getPost } from "./queries";

/**
 * 反应 / 收藏 / 订阅。
 *
 * 这三个都是「点一下立刻要有反馈」的操作，前端做乐观更新，
 * 所以这里只负责把状态落准，返回值要能让前端在失败时回滚。
 */

export type ReactionKind = (typeof REACTION_KINDS)[number];

export interface ToggleResult {
  ok: boolean;
  active?: boolean;
  count?: number;
  error?: string;
}

/** 反应是切换语义：已经点过就取消，没点过就加上 */
export async function toggleReaction(input: {
  targetType: "post" | "reply";
  targetId: string;
  kind: ReactionKind;
}): Promise<ToggleResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };
  if (!REACTION_KINDS.includes(input.kind)) return { ok: false, error: "未知的反应类型" };

  // 必须能看见才能反应，否则可以对看不见的内容试探性点赞来探测其存在
  const postId =
    input.targetType === "post"
      ? input.targetId
      : db.select({ postId: replies.postId }).from(replies).where(eq(replies.id, input.targetId)).get()
          ?.postId;
  if (!postId) return { ok: false, error: "内容不存在" };

  const viewer = buildViewerContext(user);
  if (!getPost(viewer, postId)) return { ok: false, error: "内容不存在" };

  const existing = db
    .select()
    .from(reactions)
    .where(
      and(
        eq(reactions.targetType, input.targetType),
        eq(reactions.targetId, input.targetId),
        eq(reactions.userId, user.id),
        eq(reactions.kind, input.kind),
      ),
    )
    .get();

  const table = input.targetType === "post" ? posts : replies;
  const delta = existing ? -1 : 1;

  db.transaction((tx) => {
    if (existing) {
      tx.delete(reactions).where(eq(reactions.id, existing.id)).run();
    } else {
      tx.insert(reactions)
        .values({
          targetType: input.targetType,
          targetId: input.targetId,
          userId: user.id,
          kind: input.kind,
        })
        .run();
    }
    tx.update(table)
      .set({ reactionCount: sql`MAX(0, ${table.reactionCount} + ${delta})` })
      .where(eq(table.id, input.targetId))
      .run();
  });

  const count =
    db
      .select({ n: sql<number>`count(*)` })
      .from(reactions)
      .where(
        and(
          eq(reactions.targetType, input.targetType),
          eq(reactions.targetId, input.targetId),
          eq(reactions.kind, input.kind),
        ),
      )
      .get()?.n ?? 0;

  revalidatePath(`/forum/p/${postId}`);
  return { ok: true, active: !existing, count };
}

export async function toggleBookmark(postId: string): Promise<ToggleResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const viewer = buildViewerContext(user);
  if (!getPost(viewer, postId)) return { ok: false, error: "帖子不存在" };

  const existing = db
    .select()
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, user.id), eq(bookmarks.postId, postId)))
    .get();

  if (existing) {
    db.delete(bookmarks).where(eq(bookmarks.id, existing.id)).run();
    return { ok: true, active: false };
  }

  db.insert(bookmarks).values({ userId: user.id, postId }).run();
  return { ok: true, active: true };
}

/**
 * 订阅切换。
 *
 * 退订用**静音**而不是删除记录 —— 删掉的话，
 * 下次这个人再回帖就会被自动订阅回来，等于退订按钮没用。
 */
export async function toggleSubscription(postId: string): Promise<ToggleResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const viewer = buildViewerContext(user);
  if (!getPost(viewer, postId)) return { ok: false, error: "帖子不存在" };

  const existing = db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, user.id),
        eq(subscriptions.targetType, "post"),
        eq(subscriptions.targetId, postId),
      ),
    )
    .get();

  if (!existing) {
    db.insert(subscriptions)
      .values({ userId: user.id, targetType: "post", targetId: postId, auto: false })
      .run();
    return { ok: true, active: true };
  }

  const muted = existing.mutedAt !== null;
  db.update(subscriptions)
    .set({ mutedAt: muted ? null : Date.now() })
    .where(eq(subscriptions.id, existing.id))
    .run();

  return { ok: true, active: muted };
}
