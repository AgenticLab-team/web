"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { assertNotPreviewing, getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { posts, replies, reports } from "@/lib/db/schema";
import { severityForReason } from "@/lib/moderation/rules";
import { can } from "@/lib/rbac/can";

import {
  MODERATION_TITLE,
  moderatePostCore,
  movePostCore,
  recordModerationAction,
  type ModerateAction,
} from "./manage";
import { notify } from "./notify";

/**
 * 版主工具（server action 层）。
 *
 * 两条贯穿始终的规则：
 *   1. **处罚必须填理由**。理由非空是数据库约束，不是前端校验 ——
 *      申诉时没有理由就无从判断对错
 *   2. **必须通知当事人**。悄悄删帖是最招怨的做法：
 *      作者以为自己发出去了，别人却看不到，几天后才发现
 *
 * 权限判定、写入与留痕都在 manage.ts 的核心函数里 ——
 * 这里只做「取身份 → 拦预览态 → 调核心 → revalidate」，
 * 薄一点，测试才够得到真正的边界。
 */

export interface ModResult {
  ok: boolean;
  error?: string;
  /** 可撤销的操作返回记录 id，前端据此提供「撤销」 */
  actionId?: string;
}

const fail = (error: string): ModResult => ({ ok: false, error });

/**
 * 预览态一律拦写。这里的失败模式不是「少拦一次」——
 * 是管理员以被预览者的身份写了数据，审计从此说不清是谁做的。
 */
async function previewBlocked(): Promise<string | null> {
  try {
    await assertNotPreviewing();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "预览模式下不能执行写操作";
  }
}

export async function moderatePost(input: {
  postId: string;
  action: ModerateAction;
  reason: string;
}): Promise<ModResult> {
  const blocked = await previewBlocked();
  if (blocked) return fail(blocked);

  const user = await getCurrentUser();
  const result = moderatePostCore(user, input);
  if (!result.ok) return result;

  revalidatePath(`/forum/p/${input.postId}`);
  revalidatePath("/forum");
  return result;
}

export async function movePost(input: {
  postId: string;
  toBoardId: string;
  reason?: string;
}): Promise<ModResult> {
  const blocked = await previewBlocked();
  if (blocked) return fail(blocked);

  const user = await getCurrentUser();
  const result = movePostCore(user, input);
  if (!result.ok) return result;

  revalidatePath(`/forum/p/${input.postId}`);
  revalidatePath("/forum");
  return result;
}

export async function moderateReply(input: {
  replyId: string;
  action: "hide" | "delete" | "restore" | "collapse";
  reason: string;
}): Promise<ModResult> {
  const blocked = await previewBlocked();
  if (blocked) return fail(blocked);

  const reason = input.reason.trim();
  if (!reason) return fail("必须填写理由");

  const reply = db.select().from(replies).where(eq(replies.id, input.replyId)).get();
  if (!reply) return fail("回复不存在");
  const post = db.select().from(posts).where(eq(posts.id, reply.postId)).get();
  if (!post) return fail("帖子不存在");

  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  // 楼主可以管理自己帖子下的回复，但同样要留痕
  const isOwner = post.authorId === user.id;
  const allowed =
    isOwner || can(user, "forum.post.delete.any", { scopeType: "board", scopeId: post.boardId }).allowed;
  if (!allowed) return fail("没有权限");

  const now = Date.now();
  const patch: Partial<typeof replies.$inferInsert> = {};
  if (input.action === "collapse") {
    patch.collapsed = true;
    patch.collapseReason = reason;
  } else if (input.action === "restore") {
    patch.status = "published";
    patch.collapsed = false;
    patch.deletedAt = null;
  } else {
    patch.status = input.action === "delete" ? "deleted" : "hidden";
    if (input.action === "delete") {
      patch.deletedAt = now;
      patch.deletedBy = user.id;
      patch.deleteReason = reason;
    }
  }

  db.update(replies).set(patch).where(eq(replies.id, reply.id)).run();

  const action = recordModerationAction({
    actorId: user.id,
    targetType: "reply",
    targetId: reply.id,
    targetUserId: reply.authorId,
    action: input.action,
    reason,
  });

  if (reply.authorId !== user.id) {
    notify({
      userId: reply.authorId,
      type: "moderation",
      groupKey: `mod:${reply.id}:${input.action}`,
      title: MODERATION_TITLE[input.action] ?? "你的回复被处理了",
      body: reason,
      link: `/forum/p/${post.id}#f${reply.floor}`,
      actorId: user.id,
    });
  }

  audit({ actorId: user.id }, {
    action: `forum.reply.${input.action}`,
    targetType: "reply",
    targetId: reply.id,
    reason,
  });

  revalidatePath(`/forum/p/${post.id}`);
  return { ok: true, actionId: action.id };
}

/** 举报。同一个人对同一目标重复举报只算一次 */
export async function submitReport(input: {
  targetType: "post" | "reply" | "user";
  targetId: string;
  reasonCode: "spam" | "abuse" | "porn" | "illegal" | "privacy" | "offtopic" | "other";
  detail?: string;
}): Promise<ModResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  const existing = db
    .select()
    .from(reports)
    .where(
      and(
        eq(reports.reporterId, user.id),
        eq(reports.targetType, input.targetType),
        eq(reports.targetId, input.targetId),
      ),
    )
    .get();
  if (existing) return { ok: true };

  const severity = severityForReason(input.reasonCode);

  let targetUserId: string | undefined;
  if (input.targetType === "post") {
    targetUserId = db.select().from(posts).where(eq(posts.id, input.targetId)).get()?.authorId;
  } else if (input.targetType === "reply") {
    targetUserId = db.select().from(replies).where(eq(replies.id, input.targetId)).get()?.authorId;
  } else {
    targetUserId = input.targetId;
  }

  db.insert(reports)
    .values({
      reporterId: user.id,
      targetType: input.targetType,
      targetId: input.targetId,
      targetUserId,
      reasonCode: input.reasonCode,
      detail: input.detail?.slice(0, 500),
      severity,
    })
    .run();

  return { ok: true };
}
