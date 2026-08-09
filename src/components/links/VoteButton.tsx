"use client";

import { ThumbsUp } from "lucide-react";
import { useState, useTransition } from "react";

import { toggleVoteLink } from "@/lib/links/actions";

/**
 * 资源点赞。
 *
 * ─────────────────────────────────────────
 * 和收藏是两件事
 * ─────────────────────────────────────────
 *
 * 收藏是**私人书签**:「我以后要用」。
 * 点赞是**公开信号**:「这个真的有用」，是给下一个翻资源库的人看的。
 * 所以点赞带数字、收藏不带 —— 数字本身就是那个信号。
 *
 * 和收藏按钮一样先动再发请求:点赞是个轻动作，
 * 等一个往返才变色会让人以为没点上，于是再点一次，于是又取消了。
 * 失败时连数字一起拨回去 —— 只拨图标不拨数字的话，
 * 界面上会留下一个和服务端对不上的计数，而人会相信那个数字。
 */
export function VoteButton({
  linkId,
  initialVoted,
  initialCount,
}: {
  linkId: string;
  initialVoted: boolean;
  initialCount: number;
}) {
  const [voted, setVoted] = useState(initialVoted);
  const [count, setCount] = useState(initialCount);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      aria-pressed={voted}
      aria-label={voted ? `取消点赞，当前 ${count} 赞` : `点赞，当前 ${count} 赞`}
      title={error ?? (voted ? "取消点赞" : "这个有用")}
      disabled={pending}
      onClick={() => {
        const next = !voted;
        const prevCount = count;
        setVoted(next);
        setCount(next ? count + 1 : Math.max(0, count - 1));
        setError(null);
        startTransition(async () => {
          const result = await toggleVoteLink(linkId);
          if (!result.ok) {
            setVoted(!next);
            setCount(prevCount);
            setError(result.error ?? "操作失败");
          } else {
            setVoted(result.voted ?? next);
            // 用服务端重算出来的数,不用本地那个乐观值
            if (typeof result.voteCount === "number") setCount(result.voteCount);
          }
        });
      }}
      className="tap-target flex shrink-0 items-center gap-1 self-start rounded-full px-1.5 py-1.5 transition active:opacity-50 disabled:opacity-45"
      style={{ color: error ? "var(--danger)" : voted ? "var(--accent)" : "var(--ink-quaternary)" }}
    >
      <ThumbsUp
        className="h-4 w-4"
        strokeWidth={2}
        fill={voted ? "currentColor" : "none"}
        aria-hidden
      />
      {count > 0 && <span className="t-caption tabular-nums">{count}</span>}
    </button>
  );
}
