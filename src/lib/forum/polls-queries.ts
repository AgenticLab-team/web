import "server-only";

import { and, asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { pollOptions, pollVotes, polls } from "@/lib/db/schema";

export interface PollView {
  id: string;
  question: string | null;
  multi: boolean;
  hideUntilVoted: boolean;
  closesAt: number | null;
  closed: boolean;
  totalVotes: number;
  voted: boolean;
  /** hideUntilVoted 且未投票时为 true，此时不给票数 */
  resultsHidden: boolean;
  options: { id: string; text: string; votes: number; mine: boolean; percent: number }[];
}

/**
 * 取投票状态。
 *
 * hideUntilVoted 为真且此人还没投时，**票数一律返回 0** ——
 * 只在前端隐藏是没用的，数字已经渲染进 HTML 了。
 */
export function pollOfPost(postId: string, userId: string | null): PollView | null {
  const poll = db.select().from(polls).where(eq(polls.postId, postId)).get();
  if (!poll) return null;

  const options = db
    .select()
    .from(pollOptions)
    .where(eq(pollOptions.pollId, poll.id))
    .orderBy(asc(pollOptions.sort))
    .all();

  const mine = userId
    ? db
        .select({ optionId: pollVotes.optionId })
        .from(pollVotes)
        .where(and(eq(pollVotes.pollId, poll.id), eq(pollVotes.userId, userId)))
        .all()
        .map((v) => v.optionId)
    : [];

  const voted = mine.length > 0;
  const closed = Boolean(poll.closesAt && poll.closesAt < Date.now());
  // 结果未到公开时机时，连数字都不下发
  const resultsHidden = poll.hideUntilVoted && !voted && !closed;
  const totalVotes = options.reduce((sum, o) => sum + o.votes, 0);

  return {
    id: poll.id,
    question: poll.question,
    multi: poll.multi,
    hideUntilVoted: poll.hideUntilVoted,
    closesAt: poll.closesAt,
    closed,
    totalVotes: resultsHidden ? 0 : totalVotes,
    voted,
    resultsHidden,
    options: options.map((option) => ({
      id: option.id,
      text: option.text,
      votes: resultsHidden ? 0 : option.votes,
      mine: mine.includes(option.id),
      percent:
        resultsHidden || totalVotes === 0
          ? 0
          : Math.round((option.votes / totalVotes) * 100),
    })),
  };
}
