"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { posts, replies } from "@/lib/db/schema";
import { grantPoints } from "@/lib/points/ledger";

import { buildViewerContext } from "./context";
import { notify } from "./notify";
import { getPost } from "./queries";

/**
 * 问答：悬赏与采纳。
 *
 * 悬赏在**发起时就扣分**，不是采纳时才扣 ——
 * 否则可以挂个天价悬赏吸引回答，最后余额不足赖掉。
 * 扣掉的分进托管，采纳时转给答主；到期无人采纳则退回。
 */

export interface QaResult {
  ok: boolean;
  error?: string;
}

const fail = (error: string): QaResult => ({ ok: false, error });

export async function addBounty(input: { postId: string; amount: number }): Promise<QaResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  if (!Number.isInteger(input.amount) || input.amount <= 0) return fail("悬赏金额必须是正整数");

  const viewer = buildViewerContext(user);
  const post = getPost(viewer, input.postId);
  if (!post) return fail("帖子不存在");
  if (post.authorId !== user.id) return fail("只有提问者能加悬赏");
  if (post.type !== "question") return fail("只有提问帖能设悬赏");
  if (post.raw.solvedReplyId) return fail("已经采纳过答案了");

  // 发起时就扣，避免挂天价悬赏吸引回答最后赖掉
  const charge = grantPoints({
    userId: user.id,
    delta: -input.amount,
    reason: `为提问「${post.title}」设置悬赏`,
    refType: "post",
    refId: post.id,
  });
  if (!charge.ok) return fail(charge.error ?? "扣分失败");

  db.update(posts)
    .set({ bountyPoints: post.raw.bountyPoints + input.amount })
    .where(eq(posts.id, post.id))
    .run();

  revalidatePath(`/forum/p/${post.id}`);
  return { ok: true };
}

export async function acceptAnswer(input: { postId: string; replyId: string }): Promise<QaResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  const viewer = buildViewerContext(user);
  const post = getPost(viewer, input.postId);
  if (!post) return fail("帖子不存在");
  if (post.authorId !== user.id) return fail("只有提问者能采纳答案");
  if (post.raw.solvedReplyId) return fail("已经采纳过了");

  const reply = db
    .select()
    .from(replies)
    .where(and(eq(replies.id, input.replyId), eq(replies.postId, input.postId)))
    .get();
  if (!reply) return fail("回复不存在");
  if (reply.status !== "published") return fail("这条回复已不可见");
  if (reply.authorId === user.id) return fail("不能采纳自己的回答");

  db.transaction((tx) => {
    tx.update(posts)
      .set({ solvedReplyId: reply.id })
      .where(eq(posts.id, post.id))
      .run();
    tx.update(replies).set({ accepted: true }).where(eq(replies.id, reply.id)).run();
  });

  // 悬赏已经在设置时扣过了，这里只发给答主，不再从提问者身上扣第二次
  if (post.raw.bountyPoints > 0) {
    grantPoints({
      userId: reply.authorId,
      delta: post.raw.bountyPoints,
      reason: `回答被采纳：「${post.title}」`,
      refType: "reply",
      refId: reply.id,
      // 同一条回复只发一次，重复点击采纳不会重复发放
      idempotencyKey: `bounty-award:${reply.id}`,
    });
  }

  notify({
    userId: reply.authorId,
    type: "accepted",
    groupKey: `accepted:${reply.id}`,
    title: "你的回答被采纳了",
    body: post.title,
    link: `/forum/p/${post.id}#f${reply.floor}`,
    actorId: user.id,
    refType: "reply",
    refId: reply.id,
  });

  audit({ actorId: user.id }, {
    action: "forum.answer.accept",
    targetType: "reply",
    targetId: reply.id,
    targetLabel: post.title,
    after: { bounty: post.raw.bountyPoints },
  });

  revalidatePath(`/forum/p/${post.id}`);
  return { ok: true };
}

/** 撤销采纳。悬赏已发出去的不追回 —— 追回会让答主对采纳这件事失去信任 */
export async function unacceptAnswer(postId: string): Promise<QaResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  const viewer = buildViewerContext(user);
  const post = getPost(viewer, postId);
  if (!post) return fail("帖子不存在");
  if (post.authorId !== user.id) return fail("只有提问者能撤销采纳");
  if (!post.raw.solvedReplyId) return fail("还没有采纳任何答案");

  db.transaction((tx) => {
    tx.update(replies)
      .set({ accepted: false })
      .where(eq(replies.id, post.raw.solvedReplyId!))
      .run();
    tx.update(posts).set({ solvedReplyId: null }).where(eq(posts.id, postId)).run();
  });

  revalidatePath(`/forum/p/${postId}`);
  return { ok: true };
}
