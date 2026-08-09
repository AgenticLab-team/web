"use client";

import { Quote } from "lucide-react";

import { useQuote } from "./QuoteContext";

/**
 * 楼层上的引用入口。
 *
 * 左滑手势只在触屏上存在（SwipeRow 对鼠标不启用），
 * 桌面用户没有别的路能引用 —— 所以这里必须有一个看得见的按钮。
 * 没有 Provider（未登录 / 帖子已锁）时整个按钮不渲染。
 */
export function QuoteButton({
  replyId,
  floor,
  authorName,
}: {
  replyId: string;
  floor: number;
  authorName: string;
}) {
  const ctx = useQuote();
  if (!ctx) return null;

  return (
    <button
      type="button"
      aria-label={`引用 #${floor} 楼`}
      title="引用这条回复"
      onClick={() => ctx.setQuote({ replyId, floor, authorName })}
      className="tap-target rounded-[0.4rem] p-1.5 text-[var(--ink-quaternary)] transition hover:bg-[var(--fill)] hover:text-[var(--ink-secondary)] active:scale-90"
    >
      <Quote className="h-3.5 w-3.5" strokeWidth={1.9} aria-hidden />
    </button>
  );
}
