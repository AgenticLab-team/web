"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { moderationActions, posts, replies, reports } from "@/lib/db/schema";
import { can } from "@/lib/rbac/can";

import { buildViewerContext } from "./context";
import { notify } from "./notify";
import { removeFromIndex } from "./search";

/**
 * 版主工具。
 *
 * 两条贯穿始终的规则：
 *   1. **处罚必须填理由**。理由非空是数据库约束，不是前端校验 ——
 *      申诉时没有理由就无从判断对错
 *   2. **必须通知当事人**。悄悄删帖是最招怨的做法：
 *      作者以为自己发出去了，别人却看不到，几天后才发现
 *
 * 版主权限是**限定版块**的，所以每次判定都要把版块作为 scope 传进去。
 */

export interface ModResult {
  ok: boolean;
  error?: string;
  /** 可撤销的操作返回记录 id，前端据此提供「撤销」 */
  actionId?: string;
}

const fail = (error: string): ModResult => ({ ok: false, error });

async function requireModerator(
  permission: "forum.post.delete.any" | "forum.post.lock" | "forum.post.pin" | "forum.post.feature",
  boardId: string,
) {
  const user = await getCurrentUser();
  if (!user) return { user: null, error: "请先登录" };
  const verdict = can(user, permission, { scopeType: "board", scopeId: boardId });
  if (!verdict.allowed) return { user: null, error: verdict.reason };
  return { user, error: null };
}

function record(input: {
  actorId: string;
  targetType: "post" | "reply" | "user";
  targetId: string;
  targetUserId?: string;
  action: string;
  reason: string;
  reportId?: string;
}) {
  return db
    .insert(moderationActions)
    .values({
      actorId: input.actorId,
      targetType: input.targetType,
      targetId: input.targetId,
      targetUserId: input.targetUserId,
      action: input.action as "delete",
      reason: input.reason,
      reportId: input.reportId,
    })
    .returning({ id: moderationActions.id })
    .get();
}

export async function moderatePost(input: {
  postId: string;
  action: "hide" | "delete" | "restore" | "lock" | "unlock" | "pin" | "unpin" | "feature" | "unfeature";
  reason: string;
}): Promise<ModResult> {
  const reason = input.reason.trim();
  if (!reason) return fail("必须填写理由");

  const post = db.select().from(posts).where(eq(posts.id, input.postId)).get();
  if (!post) return fail("帖子不存在");

  const permission =
    input.action === "lock" || input.action === "unlock"
      ? "forum.post.lock"
      : input.action === "pin" || input.action === "unpin"
        ? "forum.post.pin"
        : input.action === "feature" || input.action === "unfeature"
          ? "forum.post.feature"
          : "forum.post.delete.any";

  const { user, error } = await requireModerator(permission, post.boardId);
  if (!user) return fail(error!);

  const now = Date.now();
  const patch: Partial<typeof posts.$inferInsert> = {};
  switch (input.action) {
    case "hide":
      patch.status = "hidden";
      break;
    case "delete":
      patch.status = "deleted";
      patch.deletedAt = now;
      patch.deletedBy = user.id;
      patch.deleteReason = reason;
      break;
    case "restore":
      patch.status = "published";
      patch.deletedAt = null;
      patch.deletedBy = null;
      patch.deleteReason = null;
      break;
    case "lock":
      patch.status = "locked";
      break;
    case "unlock":
      patch.status = "published";
      break;
    case "pin":
      patch.pinned = true;
      break;
    case "unpin":
      patch.pinned = false;
      break;
    case "feature":
      patch.featured = true;
      patch.featuredBy = user.id;
      patch.featuredAt = now;
      break;
    case "unfeature":
      patch.featured = false;
      break;
  }

  db.update(posts).set(patch).where(eq(posts.id, post.id)).run();

  // 删除或隐藏后要从检索索引里摘掉，否则还能被搜到标题
  if (input.action === "delete" || input.action === "hide") removeFromIndex(post.id);

  const action = record({
    actorId: user.id,
    targetType: "post",
    targetId: post.id,
    targetUserId: post.authorId,
    action: input.action,
    reason,
  });

  // 通知作者。悄悄删帖是最招怨的做法
  if (post.authorId !== user.id) {
    notify({
      userId: post.authorId,
      type: "moderation",
      groupKey: `mod:${post.id}:${input.action}`,
      title: MODERATION_TITLE[input.action],
      body: `「${post.title}」· ${reason}`,
      link: `/forum/p/${post.id}`,
      actorId: user.id,
      refType: "post",
      refId: post.id,
    });
  }

  audit({ actorId: user.id }, {
    action: `forum.post.${input.action}`,
    targetType: "post",
    targetId: post.id,
    targetLabel: post.title,
    before: { status: post.status, pinned: post.pinned, featured: post.featured },
    after: patch,
    reason,
  });

  revalidatePath(`/forum/p/${post.id}`);
  revalidatePath("/forum");
  return { ok: true, actionId: action.id };
}

const MODERATION_TITLE: Record<string, string> = {
  hide: "你的帖子被隐藏了",
  delete: "你的帖子被删除了",
  restore: "你的帖子已恢复",
  lock: "你的帖子被锁定了",
  unlock: "你的帖子已解锁",
  pin: "你的帖子被置顶了",
  unpin: "你的帖子取消了置顶",
  feature: "你的帖子被加精了",
  unfeature: "你的帖子取消了加精",
  collapse: "你的回复被折叠了",
};

export async function moderateReply(input: {
  replyId: string;
  action: "hide" | "delete" | "restore" | "collapse";
  reason: string;
}): Promise<ModResult> {
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

  const action = record({
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

  // 涉法涉黄进紧急队列，其余按普通处理
  const severity = input.reasonCode === "illegal" || input.reasonCode === "porn" ? 2 : 0;

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
