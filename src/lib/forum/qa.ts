"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { pointsLedger, posts, replies } from "@/lib/db/schema";
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

/**
 * 这笔悬赏的幂等键。**挂在帖子上，不是挂在回复上。**
 *
 * ═════════════════════════════════════════
 * 挂在回复上时，换一个采纳对象就能再付一次
 * ═════════════════════════════════════════
 *
 * 一笔悬赏只对应**一次**发放 —— 这跟最后采纳的是哪条回复没有关系。
 * 键挂在回复上的时候，「采纳 A → 取消采纳 → 采纳 B」会算出两个不同的键，
 * 于是两个人各拿到一次全额，而提问者只被扣过一次：
 * 积分流水是这个站里唯一的硬通货，那等于凭空增发。
 *
 * 换成按帖子算之后，第二次发放会撞上流水表上的唯一索引，
 * `grantPoints` 直接返回 duplicate，一分也发不出去。
 *
 * ─────────────────────────────────────────
 * 注销重绑之后它还在吗 —— 在
 * ─────────────────────────────────────────
 *
 * `forum_posts` 在注销登记表里是**匿名化**档，不是清除档：
 * 行留着，只把作者置空。所以键跟着帖子一起活下来，
 * 「注销重绑再领一次」这条路是堵死的。原来挂在回复上时也成立
 * （回复同样是匿名化档），这一点没有变差。
 */
function bountyAwardKey(postId: string): string {
  return `bounty-award:${postId}`;
}

/** 这笔悬赏发出去过没有。判据是**积分流水**，不是帖子上的任何一列 */
function bountyAwarded(postId: string): boolean {
  return Boolean(
    db
      .select({ id: pointsLedger.id })
      .from(pointsLedger)
      .where(eq(pointsLedger.idempotencyKey, bountyAwardKey(postId)))
      .get(),
  );
}

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
  /*
   * 撤销采纳之后这道门会重新打开（上面那条只看 solvedReplyId），
   * 但**钱已经付出去了** —— 一笔悬赏只发一次，键挂在帖子上。
   * 不拦的话：追加的这笔会照常从提问者身上扣走，而下一次采纳
   * 会撞上幂等键、一分也发不出去 —— 分就这么凭空少了。
   * 增发和蒸发同样致命，两头都要堵。
   */
  if (bountyAwarded(post.id)) return fail("这个提问的悬赏已经发出去了，不能再追加");

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

  /*
   * ─────────────────────────────────────────
   * 先发钱，成了再落采纳
   * ─────────────────────────────────────────
   *
   * 原来是反过来的，而且完全不看 `grantPoints` 的返回值 ——
   * 发放失败（答主账号没了、余额判定出问题）会被静默吞掉：
   * 帖子标着「已解决」，答主一分没拿到，谁也不会来报。
   *
   * 这个顺序下最坏的情况是「付了钱但没标上采纳」，
   * 而那是可自愈的：提问者再点一次，幂等键让钱不会付第二遍，
   * 采纳照常落上去。反过来的顺序留下的是不可自愈的那一半。
   */
  // 悬赏已经在设置时扣过了，这里只发给答主，不再从提问者身上扣第二次
  if (post.raw.bountyPoints > 0) {
    const award = grantPoints({
      userId: reply.authorId,
      delta: post.raw.bountyPoints,
      reason: `回答被采纳：「${post.title}」`,
      refType: "reply",
      refId: reply.id,
      // 一笔悬赏只发一次 —— 键挂在帖子上，换个采纳对象也不会再付，见 bountyAwardKey
      idempotencyKey: bountyAwardKey(post.id),
    });
    if (!award.ok) return fail(award.error ?? "悬赏发放失败，采纳没有生效");
  }

  db.transaction((tx) => {
    tx.update(posts)
      .set({ solvedReplyId: reply.id })
      .where(eq(posts.id, post.id))
      .run();
    tx.update(replies).set({ accepted: true }).where(eq(replies.id, reply.id)).run();
  });

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

/**
 * 撤销采纳。
 *
 * **悬赏已发出去的不追回** —— 追回会让答主对采纳这件事失去信任。
 * 由此有两条跟着来的规矩，都在上面：
 *   · 再采纳别人也不会再付第二次（幂等键挂在帖子上）；
 *   · 也不能再追加悬赏（追加了会扣款却发不出去，分就蒸发了）。
 * 也就是说撤销采纳只撤「哪条是答案」这个标记，钱的部分已经结清了。
 */
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
