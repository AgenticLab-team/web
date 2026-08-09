"use client";

import { ChevronDown, EyeOff } from "lucide-react";
import { useState } from "react";

import { collapsedView } from "@/lib/forum/reply-rules";

/**
 * 被折叠的回复。
 *
 * ─────────────────────────────────────────
 * 这一段之前根本不存在
 * ─────────────────────────────────────────
 *
 * `replies.collapsed` 和 `collapse_reason` 两个列一直在库里，
 * 查询也把它们取出来了 —— 而**界面上一处都没渲染**。
 * 也就是说折叠一条回复和不折叠长得一模一样。
 *
 * 那比「功能没做」更糟：版主点了折叠、数据也写进去了，
 * 看起来完全生效，而实际什么都没发生。
 *
 * ─────────────────────────────────────────
 * 折叠不是删除
 * ─────────────────────────────────────────
 *
 * 折叠的用处是「这条没营养，但它确实存在过」——
 * 藏得一干二净的话，引用过它的那几条就变成了自言自语。
 *
 * 所以仍然显示：第几楼、谁说的、**为什么被折叠**，
 * 以及一个能展开看原文的口子。理由必须显示 ——
 * 一条没有理由的折叠，和版主随手删人没有区别。
 */
export function CollapsedReply({
  floor,
  authorName,
  reason,
  children,
}: {
  floor: number;
  authorName: string;
  reason: string | null;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const view = collapsedView({ floor, authorName, reason });

  return (
    <div className="px-4 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left transition active:opacity-60"
      >
        <EyeOff
          className="h-3.5 w-3.5 shrink-0 text-[var(--ink-quaternary)]"
          strokeWidth={2}
          aria-hidden
        />
        <span className="t-caption min-w-0 flex-1 text-[var(--ink-tertiary)]">{view.summary}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-[var(--ink-quaternary)] transition-transform ${
            open ? "rotate-180" : ""
          }`}
          strokeWidth={2}
          aria-hidden
        />
      </button>

      {/*
        * 展开之后照常渲染原文。
        *
        * 不做「展开后仍然打码」那种处理 —— 折叠表达的是
        * 「不值得占版面」，不是「不能看」。真不能看的走删除。
        */}
      {open && <div className="mt-2 opacity-75">{children}</div>}
    </div>
  );
}
