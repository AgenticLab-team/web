"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { NavIcon } from "./icons";

/**
 * 手机端的「更多」。
 *
 * ─────────────────────────────────────────
 * 为什么必须有这个东西
 * ─────────────────────────────────────────
 *
 * 底部 tab 栏最多放 5 个（再多每格就窄到点不准）。而这个站有 12 个
 * 前台入口、24 个后台入口 —— 之前的做法是「侧栏放全部、tab 栏放 5 个」，
 * 于是**手机上有 7 个板块根本没有入口**：通知、资源库、活动、成员、
 * 关键词雷达、商店，以及整个后台。
 *
 * 那不是「手机端功能少一点」，那是这些功能在手机上**不存在**。
 * 而这个站大部分人是在微信里点开的。
 *
 * ─────────────────────────────────────────
 * 用原生 <dialog>
 * ─────────────────────────────────────────
 *
 * 焦点陷阱、Esc 关闭、惰性区域（inert）浏览器都给好了。
 * 自己实现一遍要几十行、还大概率漏掉「关掉之后焦点回到哪」——
 * 而那一条恰恰是键盘和读屏用户最先撞上的。
 */

export interface SheetItem {
  key: string;
  href: string;
  label: string;
  icon: string;
  description?: string;
  badge?: number;
}

export interface SheetSection {
  key: string;
  label: string;
  items: SheetItem[];
}

export function MoreSheet({
  sections,
  trigger,
  title = "全部功能",
}: {
  sections: SheetSection[];
  /** 触发按钮长什么样由调用方决定 —— tab 栏和后台顶栏是两种形态 */
  trigger: (open: () => void, isOpen: boolean) => React.ReactNode;
  title?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const pathname = usePathname();

  /*
   * **由 state 驱动 <dialog>，而不是反过来。**
   *
   * 直觉写法是点击时直接 `ref.current.showModal()` —— 但那样一来，
   * 传给触发按钮的那个闭包就在渲染期读了 ref，
   * React 编译器会拦（它拦得对：渲染期读 ref 的组件不保证会重渲）。
   *
   * 把开合当成「把 React 状态同步到一个外部系统」来写，
   * 正是 effect 该干的事，也顺带让「浏览器后退键关掉弹层」
   * 这条路径自动对上 —— 那种关闭不经过我们的代码，
   * 靠 <dialog onClose> 兜回来。
   */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (isOpen && !el.open) el.showModal();
    if (!isOpen && el.open) el.close();
  }, [isOpen]);

  const open = () => setIsOpen(true);
  const close = () => setIsOpen(false);

  return (
    <>
      {trigger(open, isOpen)}

      <dialog
        ref={ref}
        onClose={() => setIsOpen(false)}
        onClick={(e) => {
          // 点遮罩关掉 —— 手机上「点旁边关掉」是肌肉记忆
          if (e.target === ref.current) close();
        }}
        aria-label={title}
        className="m-0 max-h-[85dvh] w-full max-w-none rounded-t-[1.25rem] bg-[var(--surface)] p-0 backdrop:bg-black/40 sm:mx-auto sm:mb-auto sm:mt-[8vh] sm:max-w-[26rem] sm:rounded-[1.25rem]"
        style={{ marginTop: "auto" }}
      >
        <div className="flex items-center justify-between border-b border-[var(--hairline)] px-4 py-3">
          <h2 className="t-body font-semibold">{title}</h2>
          <button
            type="button"
            onClick={close}
            aria-label="关闭"
            className="tap-target rounded-full p-1.5 text-[var(--ink-tertiary)] transition active:opacity-50"
          >
            <X className="h-4 w-4" strokeWidth={2.2} aria-hidden />
          </button>
        </div>

        <div
          className="overflow-y-auto px-2 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] pt-2"
          style={{ maxHeight: "calc(85dvh - 3.5rem)" }}
        >
          {sections.map((section) => (
            <section key={section.key} className="mb-2">
              {section.label && (
                <h3 className="t-caption px-3 pb-1 pt-2 text-[var(--ink-tertiary)]">
                  {section.label}
                </h3>
              )}
              <ul>
                {section.items.map((item) => {
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <li key={item.key}>
                      <Link
                        href={item.href}
                        onClick={close}
                        aria-current={active ? "page" : undefined}
                        className={`flex items-center gap-3 rounded-[var(--radius-control)] px-3 py-2.5 transition active:opacity-60 ${
                          active ? "bg-[var(--surface-hover)]" : ""
                        }`}
                      >
                        <NavIcon
                          name={item.icon}
                          className="h-[18px] w-[18px] shrink-0 text-[var(--ink-tertiary)]"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="t-body block truncate">{item.label}</span>
                          {item.description && (
                            <span className="t-caption2 block truncate text-[var(--ink-quaternary)]">
                              {item.description}
                            </span>
                          )}
                        </span>
                        {item.badge != null && item.badge > 0 && (
                          <span className="t-caption2 shrink-0 rounded-full bg-[var(--accent)] px-1.5 py-px font-semibold tabular-nums text-white">
                            {item.badge > 99 ? "99+" : item.badge}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </dialog>
    </>
  );
}
