"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { replies } from "@/lib/db/schema";

import { deleteOwnPostCore, restoreOwnPostCore } from "./manage";

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
  // 自删走 manage.ts 的核心：can() 判权限、摘索引、重算版块计数、留审计。
  // 以前这里是一段只查 authorId 的裸写入，删掉的帖子还能被搜到标题
  const result = deleteOwnPostCore(user, postId);
  if (!result.ok) return result;

  revalidatePath("/forum");
  revalidatePath(`/forum/p/${postId}`);
  return { ok: true };
}

export async function restoreMyPost(postId: string): Promise<UndoResult> {
  const user = await getCurrentUser();
  const result = restoreOwnPostCore(user, postId);
  if (!result.ok) return result;

  revalidatePath("/forum");
  revalidatePath(`/forum/p/${postId}`);
  return { ok: true };
}
