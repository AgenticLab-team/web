"use client";

import { Gift } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { sendTip } from "@/lib/forum/tips";

const PRESETS = [5, 10, 20, 50];

/**
 * 打赏。
 *
 * 预设几个额度，因为自己填数字这一步会劝退大半的人 ——
 * 打赏本来就是冲动行为，多一步输入就冷了。
 */
export function TipButton({
  targetType,
  targetId,
  balance,
  received,
}: {
  targetType: "post" | "reply";
  targetId: string;
  balance: number;
  received: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  const send = (points: number) => {
    setError(null);
    startTransition(async () => {
      const result = await sendTip({ targetType, targetId, points });
      if (!result.ok) setError(result.error ?? "打赏失败");
      else {
        setOpen(false);
        setDone(true);
        setTimeout(() => setDone(false), 2400);
        router.refresh();
      }
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`t-caption flex items-center gap-1 rounded-[var(--radius-pill)] px-2.5 py-1 transition-all active:scale-95 ${
          done
            ? "bg-[var(--success)]/15 text-[var(--success)]"
            : received > 0
              ? "bg-[var(--warning)]/12 text-[var(--warning)]"
              : "bg-[var(--fill)] text-[var(--ink-tertiary)] hover:bg-[var(--fill-strong)]"
        }`}
      >
        <Gift className="h-3.5 w-3.5" strokeWidth={1.9} aria-hidden />
        {done ? "已送出" : received > 0 ? `${received} 分` : "打赏"}
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--fill)] px-2 py-1.5">
      {PRESETS.map((points) => (
        <button
          key={points}
          type="button"
          disabled={pending || points > balance}
          onClick={() => send(points)}
          className="tabular t-caption rounded-[var(--radius-pill)] bg-[var(--surface)] px-2.5 py-1 font-medium transition active:scale-95 disabled:opacity-30"
        >
          {points}
        </button>
      ))}
      <span className="tabular t-caption text-[var(--ink-quaternary)]">余额 {balance}</span>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="t-caption text-[var(--ink-tertiary)]"
      >
        取消
      </button>
      {error && (
        <span className="t-caption w-full text-[var(--danger)]" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
