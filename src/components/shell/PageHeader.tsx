"use client";

import { useEffect, useRef, useState } from "react";

/**
 * iOS 的 Large Title 行为：页面顶部是大标题，向下滚动时它滚走，
 * 同时顶部浮出一条毛玻璃条显示小标题与分隔线。
 *
 * 用 IntersectionObserver 观察一个哨兵元素，而不是监听 scroll ——
 * scroll 事件每帧都触发，在长列表上会明显掉帧。
 */
export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => setCollapsed(!entry.isIntersecting),
      // 顶栏高度约 3rem，提前一点触发，避免标题和顶栏叠在一起的中间态
      { rootMargin: "-48px 0px 0px 0px", threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div
        className={`chrome fixed inset-x-0 top-0 z-20 flex h-12 items-center justify-center px-4 transition-opacity lg:left-[var(--sidebar-width)] ${
          collapsed ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        style={collapsed ? { boxShadow: "inset 0 -0.5px 0 var(--separator)" } : undefined}
        aria-hidden={!collapsed}
      >
        <span className="t-headline truncate">{title}</span>
      </div>

      <header className="flex items-start justify-between gap-4 pt-8 pb-6">
        <div className="min-w-0 space-y-1">
          <h1 className="t-large-title truncate">{title}</h1>
          {subtitle && <p className="t-subhead text-[var(--ink-secondary)]">{subtitle}</p>}
        </div>
        {action}
      </header>
      <div ref={sentinel} aria-hidden />
    </>
  );
}
