"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { posts, replies } from "@/lib/db/schema";

/**
 * 删除与撤销。
 *
 * 删除走**软删 + 立即执行 + 给撤销窗口**，不弹确认框。
 * 恢复时要校验的是「你有没有权限删它」而不是「它是不是删了」——
 * 前者才是真正的授权判断。
 */

export interface UndoResult {
  ok: boolean;
  error?: string;
}

export async function deleteMyReply(replyId: string): Promise<UndoResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const reply = db.select().from(replies).where(eq(replies.id, replyId)).get();
  if (!reply) return { ok: false, error: "回复不存在" };
  if (reply.authorId !== user.id) return { ok: false, error: "只能删自己的回复" };

  db.update(replies)
    .set({
      status: "deleted",
      deletedAt: Date.now(),
      deletedBy: user.id,
      deleteReason: "作者删除",
    })
    .where(eq(replies.id, replyId))
    .run();

  audit({ actorId: user.id }, {
    action: "forum.post.delete.own",
    targetType: "reply",
    targetId: replyId,
    reason: "作者删除",
  });

  revalidatePath(`/forum/p/${reply.postId}`);
  return { ok: true };
}

export async function restoreMyReply(replyId: string): Promise<UndoResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const reply = db.select().from(replies).where(eq(replies.id, replyId)).get();
  if (!reply) return { ok: false, error: "回复不存在" };
  if (reply.authorId !== user.id) return { ok: false, error: "只能恢复自己的回复" };
  // 管理员删的不能被作者自己撤销回来 —— 否则处罚形同虚设
  if (reply.deletedBy && reply.deletedBy !== user.id) {
    return { ok: false, error: "这条是被管理员处理的，请走申诉" };
  }

  db.update(replies)
    .set({ status: "published", deletedAt: null, deletedBy: null, deleteReason: null })
    .where(eq(replies.id, replyId))
    .run();

  revalidatePath(`/forum/p/${reply.postId}`);
  return { ok: true };
}

export async function deleteMyPost(postId: string): Promise<UndoResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const post = db.select().from(posts).where(eq(posts.id, postId)).get();
  if (!post) return { ok: false, error: "帖子不存在" };
  if (post.authorId !== user.id) return { ok: false, error: "只能删自己的帖子" };

  db.update(posts)
    .set({ status: "deleted", deletedAt: Date.now(), deletedBy: user.id, deleteReason: "作者删除" })
    .where(eq(posts.id, postId))
    .run();

  revalidatePath("/forum");
  return { ok: true };
}

export async function restoreMyPost(postId: string): Promise<UndoResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const post = db.select().from(posts).where(eq(posts.id, postId)).get();
  if (!post) return { ok: false, error: "帖子不存在" };
  if (post.authorId !== user.id) return { ok: false, error: "只能恢复自己的帖子" };
  if (post.deletedBy && post.deletedBy !== user.id) {
    return { ok: false, error: "这篇是被管理员处理的，请走申诉" };
  }

  db.update(posts)
    .set({ status: "published", deletedAt: null, deletedBy: null, deleteReason: null })
    .where(eq(posts.id, postId))
    .run();

  revalidatePath("/forum");
  return { ok: true };
}
