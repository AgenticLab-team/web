"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/admin/guard";
import { hasPendingRequest } from "@/lib/admin/escalation";
import { audit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { postSources, posts, visibilityRequests } from "@/lib/db/schema";
import type { Visibility } from "@/lib/db/schema/forum";
import { notify } from "@/lib/forum/notify";
import {
  checkApprove,
  checkReject,
  checkRequest,
  checkWithdraw,
} from "@/lib/moderation/escalation-rules";

/**
 * 可见性提升的写操作。
 *
 * 通过之后内容会**立刻**被更多人看到，而扩散是不可逆的 ——
 * 事后撤回撤不掉别人已经看到的东西。所以所有前置条件
 * （原作者同意、非本人审核）都必须在写库之前满足，
 * 不能「先批了再补」。
 */

export interface EscalationResult {
  ok: boolean;
  error?: string;
}

const fail = (error: string): EscalationResult => ({ ok: false, error });

/** 提交申请。任何能看到这篇帖子的成员都可以提 */
export async function requestEscalation(input: {
  postId: string;
  toVisibility: Visibility;
  reason: string;
}): Promise<EscalationResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  const post = db.select().from(posts).where(eq(posts.id, input.postId)).get();
  if (!post) return fail("帖子不存在");

  const check = checkRequest({
    fromVisibility: post.visibility,
    toVisibility: input.toVisibility,
    fromGroupChat: post.visibilityLocked,
    reason: input.reason,
    hasPending: hasPendingRequest(input.postId),
  });
  if (!check.ok) return fail(check.error!);

  /*
   * 需要征得同意的人数 = 被引用消息的**去重原作者数**。
   * 用消息条数会算多：一个人连发五条只需要问他一次，
   * 而把 5 当成 5 个人会让这条申请永远凑不齐同意。
   */
  const source = db.select().from(postSources).where(eq(postSources.postId, input.postId)).get();
  const consentRequired = countDistinctAuthors(source);

  db.insert(visibilityRequests)
    .values({
      postId: input.postId,
      requestedBy: user.id,
      fromVisibility: post.visibility,
      toVisibility: input.toVisibility,
      reason: input.reason.trim(),
      consentRequired,
      consentGranted: source?.consentStatus === "granted" ? consentRequired : 0,
    })
    .run();

  revalidatePath(`/forum/p/${input.postId}`);
  revalidatePath("/admin/escalation");
  return { ok: true };
}

export async function approveEscalation(input: {
  id: string;
  note: string;
}): Promise<EscalationResult> {
  const admin = await requireAdmin("forum.visibility.review");

  const row = db.select().from(visibilityRequests).where(eq(visibilityRequests.id, input.id)).get();
  if (!row) return fail("申请不存在");

  const post = db.select().from(posts).where(eq(posts.id, row.postId)).get();
  if (!post) return fail("帖子不存在");

  const check = checkApprove({
    actorId: admin.user.id,
    requestedBy: row.requestedBy,
    postAuthorId: post.authorId,
    status: row.status,
    consentRequired: row.consentRequired,
    consentGranted: row.consentGranted,
    note: input.note,
  });
  if (!check.ok) return fail(check.error!);

  const note = input.note.trim();

  db.transaction((tx) => {
    tx.update(visibilityRequests)
      .set({
        status: "approved",
        reviewedBy: admin.user.id,
        reviewedAt: Date.now(),
        reviewNote: note,
      })
      .where(eq(visibilityRequests.id, input.id))
      .run();

    /*
     * 提升可见性的同时**解开 visibilityLocked**。
     * 不解开的话，canSeePost 里那条「群聊内容不可公开」的兜底
     * 会继续把它按群聊内容对待，等于批了个寂寞。
     * 但注意：解锁只是解开这一次提升，硬约束 1（永不 public）
     * 由 checkRequest 在入口挡住，这里不需要也不能放宽。
     */
    tx.update(posts)
      .set({
        visibility: row.toVisibility,
        visibilityLocked: false,
        updatedAt: Date.now(),
      })
      .where(eq(posts.id, row.postId))
      .run();
  });

  notify({
    userId: row.requestedBy,
    type: "moderation",
    groupKey: `escalation:${row.id}`,
    title: "你的可见性提升申请已通过",
    body: note,
    link: `/forum/p/${row.postId}`,
    actorId: admin.user.id,
  });

  audit({ actorId: admin.user.id }, {
    action: "forum.visibility.review",
    targetType: "post",
    targetId: row.postId,
    targetLabel: post.title,
    before: { visibility: row.fromVisibility, locked: true },
    after: { visibility: row.toVisibility, locked: false },
    reason: note,
  });

  revalidatePath("/admin/escalation");
  revalidatePath(`/forum/p/${row.postId}`);
  return { ok: true };
}

export async function rejectEscalation(input: {
  id: string;
  note: string;
}): Promise<EscalationResult> {
  const admin = await requireAdmin("forum.visibility.review");

  const row = db.select().from(visibilityRequests).where(eq(visibilityRequests.id, input.id)).get();
  if (!row) return fail("申请不存在");

  const check = checkReject({
    actorId: admin.user.id,
    requestedBy: row.requestedBy,
    status: row.status,
    note: input.note,
  });
  if (!check.ok) return fail(check.error!);

  const note = input.note.trim();

  db.update(visibilityRequests)
    .set({ status: "rejected", reviewedBy: admin.user.id, reviewedAt: Date.now(), reviewNote: note })
    .where(eq(visibilityRequests.id, input.id))
    .run();

  // 驳回也要给答复。石沉大海的申请只会让人下次直接复制粘贴绕过流程
  notify({
    userId: row.requestedBy,
    type: "moderation",
    groupKey: `escalation:${row.id}`,
    title: "你的可见性提升申请未通过",
    body: note,
    link: `/forum/p/${row.postId}`,
    actorId: admin.user.id,
  });

  audit({ actorId: admin.user.id }, {
    action: "forum.visibility.review",
    targetType: "post",
    targetId: row.postId,
    after: { rejected: true },
    reason: note,
  });

  revalidatePath("/admin/escalation");
  return { ok: true };
}

export async function withdrawEscalation(input: { id: string }): Promise<EscalationResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  const row = db.select().from(visibilityRequests).where(eq(visibilityRequests.id, input.id)).get();
  if (!row) return fail("申请不存在");

  const check = checkWithdraw({
    actorId: user.id,
    requestedBy: row.requestedBy,
    status: row.status,
  });
  if (!check.ok) return fail(check.error!);

  db.update(visibilityRequests)
    .set({ status: "withdrawn", reviewedAt: Date.now() })
    .where(eq(visibilityRequests.id, input.id))
    .run();

  revalidatePath("/admin/escalation");
  revalidatePath(`/forum/p/${row.postId}`);
  return { ok: true };
}

/** 被引用消息的去重原作者数 */
function countDistinctAuthors(source: typeof postSources.$inferSelect | undefined): number {
  if (!source) return 0;
  const log = source.consentLog;
  if (Array.isArray(log)) {
    return new Set(log.map((entry) => String((entry as { wxId?: string }).wxId ?? entry))).size;
  }
  // 没有同意记录时按消息条数保守估计，宁可要求得多一点
  return Array.isArray(source.messageIds) ? new Set(source.messageIds).size : 0;
}
