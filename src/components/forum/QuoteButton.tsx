"use client";

import { Reply } from "lucide-react";

import { useQuote } from "./QuoteContext";

/**
 * 楼层上的「回复」入口。
 *
 * ─────────────────────────────────────────
 * 28 条回复，0 次引用
 * ─────────────────────────────────────────
 *
 * 量出来的。原因不是没人想回复某一楼，是这个按钮原来
 * **只有一个引号图标**，用的还是最淡的墨色（`--ink-quaternary`）——
 * 没有文字，没人知道它是干什么的，多半根本没注意到它在那儿。
 *
 * 于是「楼中楼」这件事在数据上从来没发生过：`parent_id` 零行。
 * 造一个树形视图去展示一棵永远只有一层的树，是又一个死开关 ——
 * 所以先把这个动作变得看得见。
 *
 * ─────────────────────────────────────────
 * 写「回复」不写「引用」
 * ─────────────────────────────────────────
 *
 * 「引用」说的是机制（把那段话摘过来），「回复」说的是意图。
 * 人想做的是后者，而且只认后者 —— 别的论坛这个位置也都写「回复」。
 *
 * 左滑手势只在触屏上存在（SwipeRow 对鼠标不启用），
 * 桌面用户没有别的路 —— 所以这里必须有一个看得见的按钮。
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
      aria-label={`回复 ${authorName} 的 #${floor} 楼`}
      title={`回复 #${floor}`}
      onClick={() => ctx.setQuote({ replyId, floor, authorName })}
      className="tap-target inline-flex items-center gap-1 rounded-[0.4rem] px-1.5 py-1 text-[var(--ink-tertiary)] transition hover:bg-[var(--fill)] hover:text-[var(--accent)] active:scale-95"
    >
      <Reply className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
      <span className="t-caption font-medium">回复</span>
    </button>
  );
}
