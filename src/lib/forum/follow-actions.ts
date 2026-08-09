"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { assertNotPreviewing, getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { subscriptions } from "@/lib/db/schema";

import { canFollow, type FollowTarget } from "./follow-rules";
import { followCount } from "./follow";

/**
 * 关注 / 取消关注一个作者、版块或标签。
 *
 * ─────────────────────────────────────────
 * 不给被关注的人发通知
 * ─────────────────────────────────────────
 *
 * 「有人关注了你」是很多站的标配，而它泄露的正是关注列表本身
 * 想保护的东西：谁在注意谁。这个站的成员目录只对同群的人开放，
 * 一条把关注关系推到当事人面前的通知，等于把那层隐私绕过去了。
 *
 * ─────────────────────────────────────────
 * 取消关注是真的删掉
 * ─────────────────────────────────────────
 *
 * 帖子订阅用静音，因为发帖回帖会自动订阅回来 —— 删掉的话
 * 退订按钮下一次回帖就失效了。关注人／版块／标签只有手动一条路进来，
 * 没有任何东西会把它加回去，留一行「已静音」只会让列表里
 * 堆着一串自己已经取消的东西。
 */

export interface FollowResult {
  ok: boolean;
  following?: boolean;
  error?: string;
}

const fail = (error: string): FollowResult => ({ ok: false, error });

export async function toggleFollow(
  target: FollowTarget,
  targetId: string,
): Promise<FollowResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  await assertNotPreviewing();

  if (!targetId) return fail("关注对象不存在");

  const existing = db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, user.id),
        eq(subscriptions.targetType, target),
        eq(subscriptions.targetId, targetId),
      ),
    )
    .get();

  if (existing) {
    db.delete(subscriptions).where(eq(subscriptions.id, existing.id)).run();
    revalidatePath("/me/following");
    return { ok: true, following: false };
  }

  const verdict = canFollow({
    target,
    current: followCount(user.id, target),
    isSelf: target === "user" && targetId === user.id,
  });
  if (!verdict.ok) return fail(verdict.reason);

  db.insert(subscriptions)
    .values({ userId: user.id, targetType: target, targetId, auto: false })
    .run();

  revalidatePath("/me/following");
  return { ok: true, following: true };
}

/** 从「我关注的」列表里取消 —— 那里手上有的是订阅行的 id */
export async function unfollowById(subscriptionId: string): Promise<FollowResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  await assertNotPreviewing();

  // where 必须带 userId：订阅 id 是 ULID，会出现在客户端
  const changed = db
    .delete(subscriptions)
    .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.userId, user.id)))
    .run();

  if (changed.changes === 0) return fail("这条关注不存在");

  revalidatePath("/me/following");
  return { ok: true, following: false };
}
