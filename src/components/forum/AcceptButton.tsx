"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { acceptAnswer, unacceptAnswer } from "@/lib/forum/qa";

/**
 * 采纳按钮。只有提问者看得到。
 *
 * 采纳是可撤销的，所以不弹确认框 —— 直接执行，
 * 想改主意点「取消采纳」即可。悬赏发出去的不追回，
 * 追回会让答主对「采纳」这件事失去信任。
 */
export function AcceptButton({
  postId,
  replyId,
  accepted,
  hasAccepted,
}: {
  postId: string;
  replyId: string;
  accepted: boolean;
  hasAccepted: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // 已经采纳了别的回答时，其余回答不显示采纳按钮
  if (hasAccepted && !accepted) return null;

  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = accepted
              ? await unacceptAnswer(postId)
              : await acceptAnswer({ postId, replyId });
            if (!result.ok) setError(result.error ?? "操作失败");
            else router.refresh();
          })
        }
        className={`t-caption flex items-center gap-1 rounded-[var(--radius-pill)] px-2.5 py-1 font-medium transition-all active:scale-95 ${
          accepted
            ? "bg-[var(--success)]/15 text-[var(--success)]"
            : "bg-[var(--fill)] text-[var(--ink-tertiary)] hover:bg-[var(--fill-strong)] hover:text-[var(--ink-secondary)]"
        }`}
      >
        <Check className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden />
        {accepted ? "取消采纳" : "采纳"}
      </button>
      {error && (
        <span className="t-caption text-[var(--danger)]" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
