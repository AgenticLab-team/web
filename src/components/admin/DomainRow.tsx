"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";

import { DomainEditor, type DomainEditorProps } from "@/components/admin/DomainEditor";

/**
 * 域名池里的一行 —— 点开就能改。
 *
 * ─────────────────────────────────────────
 * 展开，不是跳到另一个页面
 * ─────────────────────────────────────────
 *
 * 这一页上要做的事几乎总是**比较着做**：这个域名进不进随机池、
 * 那个是不是该转成靓号。跳走再回来的话，刚才看到的对比全丢了，
 * 而一百行的列表滚回原处本身就是件烦人的事。
 *
 * 代价是展开之后这一页很长 —— 但同时只会展开一个（见下面）。
 */
export function DomainRow({
  summary,
  ...editor
}: DomainEditorProps & {
  /** 折叠时显示的那一行。整块由服务端渲染好传进来 —— 客户端只管展不展开 */
  summary: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className={open ? "bg-[var(--surface-sunken)]" : ""}>
      <button
        type="button"
        className="tap-target flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="min-w-0 flex-1">{summary}</span>
        <ChevronDown
          className={`size-4 shrink-0 text-[var(--ink-quaternary)] transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div className="border-t border-[var(--separator)] px-3 pb-3 pt-3">
          <DomainEditor {...editor} onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
