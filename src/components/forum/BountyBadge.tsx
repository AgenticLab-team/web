"use client";

import { Coins } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { addBounty } from "@/lib/forum/qa";

/**
 * 悬赏。发起时就扣分 ——
 * 否则可以挂个天价悬赏吸引回答，最后余额不足赖掉。
 */
export function BountyBadge({
  postId,
  amount,
  canAdd,
  balance,
}: {
  postId: string;
  amount: number;
  canAdd: boolean;
  balance: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(20);
  const [error, setError] = useState<string | null>(null);

  if (amount === 0 && !canAdd) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {amount > 0 && (
        <span className="t-footnote flex items-center gap-1 rounded-[var(--radius-pill)] bg-[var(--warning)]/15 px-2.5 py-1 font-medium text-[var(--warning)]">
          <Coins className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          悬赏 {amount} 分
        </span>
      )}

      {canAdd && !open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="t-caption rounded-[var(--radius-pill)] bg-[var(--fill)] px-2.5 py-1 text-[var(--ink-tertiary)] transition hover:bg-[var(--fill-strong)]"
        >
          {amount > 0 ? "追加悬赏" : "设置悬赏"}
        </button>
      )}

      {canAdd && open && (
        <span className="flex items-center gap-1.5">
          <input
            type="number"
            aria-label="悬赏积分"
            min={1}
            max={balance}
            value={value}
            onChange={(e) => setValue(Number(e.target.value))}
            className="tabular t-footnote w-20 rounded-[var(--radius-control)] bg-[var(--fill)] px-2 py-1 outline-none"
          />
          <button
            type="button"
            disabled={pending || value < 1 || value > balance}
            onClick={() =>
              startTransition(async () => {
                const result = await addBounty({ postId, amount: value });
                if (!result.ok) setError(result.error ?? "失败");
                else {
                  setOpen(false);
                  setError(null);
                  router.refresh();
                }
              })
            }
            className="t-caption rounded-[var(--radius-pill)] bg-[var(--accent)] px-2.5 py-1 font-medium text-[var(--accent-ink)] disabled:opacity-40"
          >
            确定
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="t-caption text-[var(--ink-tertiary)]"
          >
            取消
          </button>
          <span className="t-caption text-[var(--ink-quaternary)]">余额 {balance}</span>
        </span>
      )}

      {error && (
        <span className="t-caption text-[var(--danger)]" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
