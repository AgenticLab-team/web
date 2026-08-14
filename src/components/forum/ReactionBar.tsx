"use client";

import { useOptimistic, useState, useTransition } from "react";

import { toggleReaction, type ReactionKind } from "@/lib/forum/social";

/**
 * 多维反应。
 *
 * 只有一个「赞」的话信息量太少 —— 分不出「这条有用」和「这条我喜欢」。
 * 四个维度已经是上限，再多用户就不会挨个想了。
 *
 * 点击走**乐观更新**：立刻变色变数字，请求在后台发，失败再回滚。
 * 让用户盯着转圈等，是把网络延迟转嫁给用户。
 */

const KINDS: { kind: ReactionKind; emoji: string; label: string }[] = [
  { kind: "useful", emoji: "👍", label: "有用" },
  { kind: "insight", emoji: "💡", label: "有启发" },
  { kind: "precise", emoji: "🎯", label: "说到点上" },
  { kind: "love", emoji: "❤️", label: "喜欢" },
];

export interface ReactionState {
  kind: ReactionKind;
  count: number;
  mine: boolean;
}

export function ReactionBar({
  targetType,
  targetId,
  initial,
  canReact,
  compact = false,
}: {
  targetType: "post" | "reply";
  targetId: string;
  initial: ReactionState[];
  canReact: boolean;
  compact?: boolean;
}) {
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [state, applyOptimistic] = useOptimistic(
    initial,
    (current: ReactionState[], kind: ReactionKind) =>
      current.map((r) =>
        r.kind === kind ? { ...r, mine: !r.mine, count: r.count + (r.mine ? -1 : 1) } : r,
      ),
  );

  const react = (kind: ReactionKind) => {
    if (!canReact) return;
    setError(null);
    startTransition(async () => {
      applyOptimistic(kind);
      const result = await toggleReaction({ targetType, targetId, kind });
      // 失败时 useOptimistic 会自动回到服务端状态，只需把原因告诉用户
      if (!result.ok) setError(result.error ?? "操作失败");
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {state.map((r) => {
        const meta = KINDS.find((k) => k.kind === r.kind)!;
        // 没人点过的维度对访客隐藏，免得一排零很难看
        if (!canReact && r.count === 0) return null;
        return (
          <button
            key={r.kind}
            type="button"
            disabled={!canReact}
            onClick={() => react(r.kind)}
            aria-pressed={r.mine}
            aria-label={`${meta.label}${r.count > 0 ? ` ${r.count}` : ""}`}
            title={meta.label}
            className={`tap-target flex items-center gap-1 rounded-[var(--radius-pill)] transition ${
              compact ? "px-2 py-1" : "px-2.5 py-1.5"
            } ${
              r.mine
                ? "bg-[var(--accent-soft)] text-[var(--accent)] ring-1 ring-[var(--accent)]/25"
                : "bg-[var(--fill)] text-[var(--ink-tertiary)]"
            } ${canReact ? "hover:bg-[var(--fill-strong)] active:scale-95" : "cursor-default"}`}
          >
            <span className={compact ? "text-[0.8125rem]" : "text-[0.9375rem]"} aria-hidden>
              {meta.emoji}
            </span>
            {r.count > 0 && (
              <span className="tabular t-caption font-medium">{r.count}</span>
            )}
          </button>
        );
      })}

      {error && (
        <span className="t-caption text-[var(--danger)]" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
