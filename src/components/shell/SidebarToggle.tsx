"use client";

import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useSyncExternalStore } from "react";

import { readSidebarState, SIDEBAR_STORAGE_KEY, type SidebarState } from "@/lib/sidebar";

/**
 * 收起 / 展开侧栏的那个按钮。
 *
 * ─────────────────────────────────────────
 * 状态的真源是 DOM 上那个属性，不是 React
 * ─────────────────────────────────────────
 *
 * 因为绘制前那段脚本已经把它写上去了（见 lib/sidebar.ts）。
 * React 这边再存一份的话，两份在 hydration 的一瞬间必然不一致 ——
 * 服务端不知道这个人上次收没收。
 *
 * 所以这里 `useSyncExternalStore` 直接读 DOM：
 * 服务端快照恒为「展开」，客户端第一帧读到真实值。
 * 视觉上不会闪，因为长相由 CSS 按属性决定，跟这个 hook 无关 ——
 * 它只用来把图标和 aria 说对。
 */

const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function current(): SidebarState {
  return document.documentElement.getAttribute("data-sidebar") === "rail" ? "rail" : "wide";
}

function apply(next: SidebarState) {
  if (next === "rail") document.documentElement.setAttribute("data-sidebar", "rail");
  else document.documentElement.removeAttribute("data-sidebar");
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, next);
  } catch {
    /* Safari 隐私模式下会抛 —— 存不下就只是这次不记住，不该连收起都失败 */
  }
  for (const fn of listeners) fn();
}

export function SidebarToggle() {
  const state = useSyncExternalStore(
    subscribe,
    current,
    // 服务端快照。真值只在浏览器里有，这里必须给一个稳定的常量
    () => readSidebarState(null),
  );
  const rail = state === "rail";
  const Icon = rail ? PanelLeftOpen : PanelLeftClose;

  return (
    <button
      type="button"
      onClick={() => apply(rail ? "wide" : "rail")}
      /*
       * 收起之后按钮上没有字了，所以 aria-label 是它唯一的名字。
       * 说「展开侧栏」而不是「切换侧栏」—— 读屏用户需要知道
       * 按下去会发生什么，而不是这里有个开关。
       */
      aria-label={rail ? "展开侧栏" : "收起侧栏"}
      title={rail ? "展开侧栏" : "收起侧栏"}
      /*
       * 44×44。收起之后它和导航图标在同一条竖线上，尺寸不一致的话
       * 那一列看起来是歪的；而且这是整个侧栏上**唯一一个按了会变形**的东西，
       * 手感必须跟得上手 —— 按压给一点缩放，比只换底色说得清楚。
       */
      className="sidebar-row flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--ink-tertiary)] transition hover:bg-[var(--fill)] hover:text-[var(--ink)] active:scale-[0.92]"
    >
      <Icon className="h-[1.125rem] w-[1.125rem]" strokeWidth={1.75} aria-hidden />
    </button>
  );
}
