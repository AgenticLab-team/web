"use client";

import { Check, Loader2, Plus } from "lucide-react";
import { useOptimistic, useState, useTransition } from "react";

import { toggleFollow } from "@/lib/forum/follow-actions";
import { TARGET_LABEL, type FollowTarget } from "@/lib/forum/follow-rules";

/**
 * 关注按钮。作者、版块、标签共用一个。
 *
 * ─────────────────────────────────────────
 * 已关注时不写「取消关注」
 * ─────────────────────────────────────────
 *
 * 按钮上的字应该说**现在的状态**，不是说点下去会发生什么 ——
 * 否则一个「取消关注」的按钮，会让没关注的人以为自己已经关注了。
 * 悬停和 aria-label 里再说动作。
 *
 * ─────────────────────────────────────────
 * 关注是私密的，所以这里不显示任何数字
 * ─────────────────────────────────────────
 *
 * 「1.2k 人关注」看起来无害，而它是关注列表的聚合视图 ——
 * 这个站的成员目录只对同群的人开放，一个公开的关注数
 * 会把「谁受关注」摊给所有人，包括没登录的。
 */
export function FollowButton({
  target,
  targetId,
  following,
  size = "default",
}: {
  target: FollowTarget;
  targetId: string;
  following: boolean;
  size?: "default" | "compact";
}) {
  const [pending, startTransition] = useTransition();
  const [on, setOn] = useOptimistic(following, (_: boolean, next: boolean) => next);
  const [error, setError] = useState<string | null>(null);

  const label = on
    ? `已关注这个${TARGET_LABEL[target]}，点一下取消`
    : `关注这个${TARGET_LABEL[target]}，有新帖时通知你`;

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-pressed={on}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setOn(!on);
            const r = await toggleFollow(target, targetId);
            // 失败时把话说出来 —— 关注上限是个真会撞上的规则
            if (!r.ok) setError(r.error ?? "没成功");
            else setError(null);
          })
        }
        className={`tap-target inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-pill)] font-medium transition active:scale-[0.96] disabled:opacity-50 ${
          size === "compact" ? "t-caption px-2.5 py-1" : "t-footnote min-h-9 px-3.5"
        } ${
          on
            ? "bg-[var(--fill)] text-[var(--ink-secondary)]"
            : "bg-[var(--accent)] text-[var(--accent-ink)]"
        }`}
      >
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.2} aria-hidden />
        ) : on ? (
          <Check className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden />
        ) : (
          <Plus className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden />
        )}
        {on ? "已关注" : "关注"}
      </button>

      {error && <p className="t-caption max-w-[16rem] text-right text-[var(--danger)]">{error}</p>}
    </div>
  );
}
