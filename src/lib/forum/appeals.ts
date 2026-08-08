"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { appeals, moderationActions } from "@/lib/db/schema";
import { checkHandleAppeal } from "@/lib/moderation/rules";
import { can } from "@/lib/rbac/can";

import { notify } from "./notify";

/**
 * 申诉。
 *
 * **有处罚就必须有申诉**。只罚不给申诉，管理只会积累怨气 ——
 * 被误伤的人无处说理，最后要么退群要么在群里吵，
 * 两种结果都比多做一个申诉入口贵得多。
 *
 * 与之配套的是**不能复核自己下的处罚**（见 moderation/rules.ts）。
 * 由原处罚人来判，等于让他给自己的判断打分，结果几乎注定是驳回 ——
 * 那这个入口只是让人多绕一圈再绝望一次，还不如没有。
 */

export interface AppealResult {
  ok: boolean;
  error?: string;
}

export async function submitAppeal(input: {
  actionId: string;
  content: string;
}): Promise<AppealResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const content = input.content.trim();
  if (content.length < 5) return { ok: false, error: "请说明一下情况，太短了看不出问题" };

  const action = db
    .select()
    .from(moderationActions)
    .where(eq(moderationActions.id, input.actionId))
    .get();
  if (!action) return { ok: false, error: "找不到这条处罚记录" };
  // 只能申诉针对自己的处罚
  if (action.targetUserId !== user.id) return { ok: false, error: "找不到这条处罚记录" };

  const existing = db
    .select()
    .from(appeals)
    .where(and(eq(appeals.actionId, input.actionId), eq(appeals.userId, user.id)))
    .get();
  if (existing) return { ok: false, error: "你已经申诉过了，请等待处理" };

  db.insert(appeals).values({ userId: user.id, actionId: action.id, content }).run();

  revalidatePath("/me/moderation");
  return { ok: true };
}

export async function handleAppeal(input: {
  appealId: string;
  accept: boolean;
  response: string;
}): Promise<AppealResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };
  const verdict = can(user, "moderation.appeal");
  if (!verdict.allowed) return { ok: false, error: verdict.reason };

  const response = input.response.trim();

  const appeal = db.select().from(appeals).where(eq(appeals.id, input.appealId)).get();
  if (!appeal) return { ok: false, error: "申诉不存在" };

  const action = db
    .select()
    .from(moderationActions)
    .where(eq(moderationActions.id, appeal.actionId))
    .get();
  if (!action) return { ok: false, error: "找不到对应的处罚记录" };

  const check = checkHandleAppeal({
    actorId: user.id,
    punisherId: action.actorId,
    appealantId: appeal.userId,
    status: appeal.status,
    response: input.response,
  });
  if (!check.ok) return { ok: false, error: check.error };

  db.transaction((tx) => {
    tx.update(appeals)
      .set({
        status: input.accept ? "accepted" : "rejected",
        handledBy: user.id,
        handledAt: Date.now(),
        response,
      })
      .where(eq(appeals.id, appeal.id))
      .run();

    // 申诉成立就把处罚标记为已撤销，档案上要看得出这次是误判
    if (input.accept) {
      tx.update(moderationActions)
        .set({ revertedBy: user.id, revertedAt: Date.now() })
        .where(eq(moderationActions.id, appeal.actionId))
        .run();
    }
  });

  notify({
    userId: appeal.userId,
    type: "moderation",
    groupKey: `appeal:${appeal.id}`,
    title: input.accept ? "你的申诉已被采纳" : "你的申诉未被采纳",
    body: response,
    link: "/me/moderation",
    actorId: user.id,
  });

  audit({ actorId: user.id }, {
    action: "moderation.appeal",
    targetType: "appeal",
    targetId: appeal.id,
    after: { accepted: input.accept },
    reason: response,
  });

  revalidatePath("/admin/appeals");
  return { ok: true };
}
