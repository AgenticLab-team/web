"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { replies, tips } from "@/lib/db/schema";
import { transferPoints } from "@/lib/points/ledger";
import { resolveDisplayName } from "@/lib/users/display-name";

import { buildViewerContext } from "./context";
import { notify } from "./notify";
import { getPost } from "./queries";

/**
 * 打赏。给积分一个真正的消耗出口 ——
 * 积分只能攒不能花的话，等级就只是个虚数。
 */

export interface TipResult {
  ok: boolean;
  error?: string;
}

export async function sendTip(input: {
  targetType: "post" | "reply";
  targetId: string;
  points: number;
  note?: string;
}): Promise<TipResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };
  if (!Number.isInteger(input.points) || input.points <= 0) {
    return { ok: false, error: "打赏金额必须是正整数" };
  }

  const postId =
    input.targetType === "post"
      ? input.targetId
      : db.select().from(replies).where(eq(replies.id, input.targetId)).get()?.postId;
  if (!postId) return { ok: false, error: "内容不存在" };

  const viewer = buildViewerContext(user);
  const post = getPost(viewer, postId);
  if (!post) return { ok: false, error: "内容不存在" };

  const toUserId =
    input.targetType === "post"
      ? post.authorId
      : db.select().from(replies).where(eq(replies.id, input.targetId)).get()?.authorId;
  if (!toUserId) return { ok: false, error: "找不到作者" };
  if (toUserId === user.id) return { ok: false, error: "不能打赏自己" };

  const transfer = transferPoints({
    fromUserId: user.id,
    toUserId,
    amount: input.points,
    reason: `打赏「${post.title}」`,
    refType: input.targetType,
    refId: input.targetId,
  });
  if (!transfer.ok) return { ok: false, error: transfer.error };

  db.insert(tips)
    .values({
      targetType: input.targetType,
      targetId: input.targetId,
      postId,
      fromUserId: user.id,
      toUserId,
      points: input.points,
      note: input.note?.slice(0, 100),
    })
    .run();

  notify({
    userId: toUserId,
    type: "reaction",
    groupKey: `tip:${input.targetId}`,
    title: `${resolveDisplayName([user.siteNickname, user.wxNickname], { wxId: user.wxId, fallback: "有人" })}打赏了你 ${input.points} 分`,
    body: input.note || post.title,
    link: `/forum/p/${postId}`,
    actorId: user.id,
    actorName:
      resolveDisplayName([user.siteNickname, user.wxNickname], { wxId: user.wxId, fallback: "" }) ||
      undefined,
  });

  revalidatePath(`/forum/p/${postId}`);
  return { ok: true };
}
