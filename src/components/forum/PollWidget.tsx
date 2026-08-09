"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { castVote, retractVote } from "@/lib/forum/polls";
import type { PollView } from "@/lib/forum/polls-queries";

/**
 * 投票组件。
 *
 * 未投票时是可点的选项，投票后变成结果条 —— 同一块区域两种形态，
 * 不做「投票区 + 结果区」两栏：那样在手机上要滚很久才看得全。
 *
 * 允许撤票。投错了没法改会让人不敢投，宁可不参与。
 */
export function PollWidget({ poll, canVote }: { poll: PollView; canVote: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState<Set<string>>(new Set());

  const showResults = poll.voted || poll.closed || !poll.resultsHidden;
  const interactive = canVote && !poll.closed;

  const submit = (optionIds: string[]) => {
    setError(null);
    startTransition(async () => {
      const result = await castVote({ pollId: poll.id, optionIds });
      if (!result.ok) setError(result.error ?? "投票失败");
      else {
        setStaged(new Set());
        router.refresh();
      }
    });
  };

  const toggle = (id: string) => {
    if (!interactive) return;
    if (!poll.multi) {
      submit([id]);
      return;
    }
    setStaged((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="my-5 space-y-3 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline">
      {poll.question && <p className="t-headline">{poll.question}</p>}

      <div className="space-y-2">
        {poll.options.map((option) => {
          const checked = poll.multi ? staged.has(option.id) || option.mine : option.mine;
          return (
            <button
              key={option.id}
              type="button"
              disabled={!interactive || pending}
              onClick={() => toggle(option.id)}
              aria-pressed={checked}
              className={`relative w-full overflow-hidden rounded-[var(--radius-control)] px-3.5 py-2.5 text-left transition-all ${
                interactive ? "active:scale-[0.99]" : ""
              } ${checked ? "bg-[var(--accent-soft)]" : "bg-[var(--fill)]"}`}
            >
              {/* 结果条画在背景层，文字始终在上面，不会被遮住 */}
              {showResults && (
                <span
                  className="absolute inset-y-0 left-0 bg-[var(--accent)]/12 transition-[width] duration-500"
                  style={{ width: `${option.percent}%` }}
                  aria-hidden
                />
              )}

              <span className="relative flex items-center gap-2">
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center border transition-colors ${
                    poll.multi ? "rounded-[0.25rem]" : "rounded-full"
                  } ${
                    checked
                      ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)]"
                      : "border-[var(--ink-quaternary)]"
                  }`}
                  aria-hidden
                >
                  {checked && <Check className="h-2.5 w-2.5" strokeWidth={3.5} aria-hidden />}
                </span>

                <span className="t-subhead min-w-0 flex-1">{option.text}</span>

                {showResults && (
                  <span className="tabular t-caption shrink-0 text-[var(--ink-secondary)]">
                    {option.percent}% · {option.votes}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {poll.multi && staged.size > 0 && (
        <button
          type="button"
          disabled={pending}
          onClick={() => submit([...staged, ...poll.options.filter((o) => o.mine).map((o) => o.id)])}
          className="t-footnote w-full rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)]"
        >
          提交投票
        </button>
      )}

      {error && (
        <p className="t-caption text-[var(--danger)]" role="alert">
          {error}
        </p>
      )}

      <div className="tabular t-caption flex items-center gap-2 text-[var(--ink-tertiary)]">
        <span>
          {poll.resultsHidden && !poll.voted
            ? "投票后可见结果"
            : `${poll.totalVotes} 人参与`}
        </span>
        {poll.multi && <span>· 多选</span>}
        {poll.closed && <span>· 已结束</span>}
        {poll.voted && !poll.closed && (
          <>
            <span className="flex-1" />
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  await retractVote(poll.id);
                  router.refresh();
                })
              }
              className="text-[var(--accent)] transition active:opacity-60"
            >
              撤销投票
            </button>
          </>
        )}
      </div>
    </div>
  );
}
