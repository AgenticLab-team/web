"use client";

import { ChevronDown } from "lucide-react";
import { usePathname } from "next/navigation";

import { MoreSheet, type SheetSection } from "@/components/shell/MoreSheet";
import type { AdminNavSection } from "@/lib/admin/nav";

/**
 * 手机端的后台板块选择器。
 *
 * ─────────────────────────────────────────
 * 24 个入口不能堆在正文上面
 * ─────────────────────────────────────────
 *
 * 之前后台侧栏那个 `<aside>` 在手机上直接堆在正文之上：
 * 24 行链接压在每一个后台页面的头顶，人要滚过整份目录
 * 才看得到自己点进来要看的东西。
 *
 * 那不算「手机上有入口」—— 那是把内容推到了第二屏。
 *
 * 现在只占一行：显示**你现在在哪**，点开才是完整目录。
 * 显示当前位置这一条不是装饰:后台页面之间长得很像,
 * 没有它人经常不确定自己点进来的是哪一个。
 */
export function AdminNavPicker({ sections }: { sections: AdminNavSection[] }) {
  const pathname = usePathname();

  const all = sections.flatMap((s) => s.items);
  const current =
    all.find((i) => pathname === i.href) ??
    all.find((i) => i.href !== "/admin" && pathname.startsWith(`${i.href}/`));

  const sheetSections: SheetSection[] = sections.map((s) => ({
    key: s.key,
    label: s.label,
    items: s.items.map((i) => ({
      key: i.key,
      href: i.href,
      label: i.label,
      icon: i.icon,
      description: i.description,
    })),
  }));

  return (
    <MoreSheet
      title="管理区"
      sections={sheetSections}
      trigger={(open, isOpen) => (
        <button
          type="button"
          onClick={open}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          className="flex w-full items-center gap-2 rounded-[var(--radius-control)] bg-[var(--surface)] px-3 py-2.5 text-left hairline transition active:opacity-60"
        >
          <span className="min-w-0 flex-1">
            <span className="t-caption2 block text-[var(--ink-quaternary)]">管理区</span>
            <span className="t-body block truncate font-medium">
              {current?.label ?? "总览"}
            </span>
          </span>
          <ChevronDown
            className="h-4 w-4 shrink-0 text-[var(--ink-tertiary)]"
            strokeWidth={2.2}
            aria-hidden
          />
        </button>
      )}
    />
  );
}
