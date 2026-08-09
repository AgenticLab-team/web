"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { assertNotPreviewing, getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { posts } from "@/lib/db/schema";

import { checkSchedule } from "./schedule-rules";
import { publishDueScheduled } from "./schedule";

/**
 * 定时发布的三个动作：现在就发、改时间、撤回成草稿。
 *
 * ─────────────────────────────────────────
 * 都只认自己的帖子
 * ─────────────────────────────────────────
 *
 * 待发布的帖子对版主是可见的（`canSeePost` 里草稿对版主放行），
 * 而**可见不等于可以替人发**。一个版主能把别人还没想好要不要发的
 * 东西提前按发布，那比看到它严重得多。
 * 所以下面每一条 where 都带 authorId。
 */

export interface Result {
  ok: boolean;
  error?: string;
}

const fail = (error: string): Result => ({ ok: false, error });

/** 不等了，现在就发 */
export async function publishNow(postId: string): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  await assertNotPreviewing();

  const row = db
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(
        eq(posts.id, postId),
        eq(posts.authorId, user.id),
        eq(posts.status, "draft"),
        isNull(posts.deletedAt),
      ),
    )
    .get();
  if (!row) return fail("这篇帖子不在等待发布");

  /*
   * 把时间改成「现在」，然后走**和定时任务完全同一条**发布路径。
   *
   * 直接在这里写一遍 status = published 的话，就有了第二条发布路径 ——
   * 而计数重算、板块时间、通知扇出这三件事只要有一处忘了抄，
   * 手动发出来的帖子就会和定时发出来的不一样，
   * 且只有其中一条路会被测到。
   */
  db.update(posts).set({ scheduledAt: Date.now() }).where(eq(posts.id, postId)).run();
  publishDueScheduled();

  revalidatePath("/me/drafts");
  revalidatePath(`/forum/p/${postId}`);
  return { ok: true };
}

/** 改个时间 */
export async function reschedule(postId: string, at: number): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  await assertNotPreviewing();

  const verdict = checkSchedule(at, Date.now());
  if (!verdict.ok) return fail(verdict.reason);

  const changed = db
    .update(posts)
    .set({ scheduledAt: verdict.at })
    .where(
      and(
        eq(posts.id, postId),
        eq(posts.authorId, user.id),
        eq(posts.status, "draft"),
        isNull(posts.deletedAt),
      ),
    )
    .run();
  if (changed.changes === 0) return fail("这篇帖子不在等待发布");

  revalidatePath("/me/drafts");
  return { ok: true };
}

/**
 * 取消定时 —— 变成一篇**没有时间**的草稿，不是删掉。
 *
 * 删掉的话，一次「我再想想」就毁掉了整篇内容。
 * 留成草稿之后它还在「等着发的」列表里，只是不会自己发出去。
 */
export async function cancelSchedule(postId: string): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  await assertNotPreviewing();

  const changed = db
    .update(posts)
    .set({ scheduledAt: null })
    .where(
      and(
        eq(posts.id, postId),
        eq(posts.authorId, user.id),
        eq(posts.status, "draft"),
        isNull(posts.deletedAt),
      ),
    )
    .run();
  if (changed.changes === 0) return fail("这篇帖子不在等待发布");

  revalidatePath("/me/drafts");
  return { ok: true };
}
