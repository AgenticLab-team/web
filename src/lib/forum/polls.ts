"use server";

import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { pollOptions, pollVotes, polls, posts } from "@/lib/db/schema";

import { buildViewerContext } from "./context";
import { checkClosesAt, normalizePollDraft } from "./poll-rules";
import { getPost } from "./queries";

/**
 * 投票。
 *
 * 两条容易写错的规则：
 *   1. **单选换票要先撤旧票**，否则同一个人的两票都算进结果
 *   2. **改票要在事务里做**，中途失败会留下票数与投票记录对不上的状态
 */

export interface PollResult {
  ok: boolean;
  error?: string;
}

const fail = (error: string): PollResult => ({ ok: false, error });

export async function createPoll(input: {
  postId: string;
  question?: string;
  options: string[];
  multi?: boolean;
  hideUntilVoted?: boolean;
  closesAt?: number;
}): Promise<PollResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  const post = db.select().from(posts).where(eq(posts.id, input.postId)).get();
  if (!post) return fail("帖子不存在");
  if (post.authorId !== user.id) return fail("只有作者能加投票");

  const existing = db.select().from(polls).where(eq(polls.postId, input.postId)).get();
  if (existing) return fail("这篇帖子已经有投票了");

  /*
   * 校验走和发帖那条路**同一份实现**。
   *
   * 两条路径各写一份的话迟早分叉，而分叉的表现是
   * 「从这个入口建的投票有 12 个选项上限，从那个入口建的没有」——
   * 没人查得出为什么。
   */
  const check = normalizePollDraft(input);
  if (!check.ok) return fail(check.error);
  const timeCheck = checkClosesAt(input.closesAt, Date.now());
  if (timeCheck && !timeCheck.ok) return fail(timeCheck.error);
  const cleaned = check.options;

  db.transaction((tx) => {
    const poll = tx
      .insert(polls)
      .values({
        postId: input.postId,
        question: check.question,
        multi: Boolean(input.multi),
        hideUntilVoted: Boolean(input.hideUntilVoted),
        closesAt: input.closesAt,
      })
      .returning({ id: polls.id })
      .get();

    cleaned.forEach((text, sort) => {
      tx.insert(pollOptions).values({ pollId: poll.id, text, sort }).run();
    });

    tx.update(posts).set({ type: "poll" }).where(eq(posts.id, input.postId)).run();
  });

  revalidatePath(`/forum/p/${input.postId}`);
  return { ok: true };
}

export async function castVote(input: {
  pollId: string;
  optionIds: string[];
}): Promise<PollResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  const poll = db.select().from(polls).where(eq(polls.id, input.pollId)).get();
  if (!poll) return fail("投票不存在");
  if (poll.closesAt && poll.closesAt < Date.now()) return fail("投票已结束");

  // 看不见这个帖子就不能投票
  const viewer = buildViewerContext(user);
  if (!getPost(viewer, poll.postId)) return fail("帖子不存在");

  const validOptions = db
    .select({ id: pollOptions.id })
    .from(pollOptions)
    .where(eq(pollOptions.pollId, poll.id))
    .all()
    .map((o) => o.id);

  const chosen = [...new Set(input.optionIds)].filter((id) => validOptions.includes(id));
  if (chosen.length === 0) return fail("请选择一个选项");
  if (!poll.multi && chosen.length > 1) return fail("这是单选投票");

  db.transaction((tx) => {
    /*
     * 先撤销这个人在本投票里的所有旧票，再记新票。
     * 不撤旧票的话，单选投票里同一个人换一次选项就多算一票。
     */
    const previous = tx
      .select()
      .from(pollVotes)
      .where(and(eq(pollVotes.pollId, poll.id), eq(pollVotes.userId, user.id)))
      .all();

    if (previous.length > 0) {
      tx.delete(pollVotes)
        .where(and(eq(pollVotes.pollId, poll.id), eq(pollVotes.userId, user.id)))
        .run();
      tx.update(pollOptions)
        .set({ votes: sql`MAX(0, ${pollOptions.votes} - 1)` })
        .where(inArray(pollOptions.id, previous.map((p) => p.optionId)))
        .run();
    }

    for (const optionId of chosen) {
      tx.insert(pollVotes)
        .values({ pollId: poll.id, optionId, userId: user.id })
        .run();
      tx.update(pollOptions)
        .set({ votes: sql`${pollOptions.votes} + 1` })
        .where(eq(pollOptions.id, optionId))
        .run();
    }
  });

  revalidatePath(`/forum/p/${poll.postId}`);
  return { ok: true };
}

/** 撤销投票。允许反悔 —— 投错了没法改会让人不敢投 */
export async function retractVote(pollId: string): Promise<PollResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  const poll = db.select().from(polls).where(eq(polls.id, pollId)).get();
  if (!poll) return fail("投票不存在");
  if (poll.closesAt && poll.closesAt < Date.now()) return fail("投票已结束");

  db.transaction((tx) => {
    const previous = tx
      .select()
      .from(pollVotes)
      .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, user.id)))
      .all();
    if (previous.length === 0) return;

    tx.delete(pollVotes)
      .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, user.id)))
      .run();
    tx.update(pollOptions)
      .set({ votes: sql`MAX(0, ${pollOptions.votes} - 1)` })
      .where(inArray(pollOptions.id, previous.map((p) => p.optionId)))
      .run();
  });

  revalidatePath(`/forum/p/${poll.postId}`);
  return { ok: true };
}
