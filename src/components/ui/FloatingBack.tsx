"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/**
 * 划下去之后仍然回得来的那个返回。
 *
 * ═════════════════════════════════════════
 * 站长报的两条，其实是同一条
 * ═════════════════════════════════════════
 *
 *   ·「那个回到上级页面的按钮在最上面，读完长文章要回去就得翻回最上面」
 *   ·「我在手机上不能回到上一页」
 *
 * 第二条尤其要紧：manifest 里 `display: standalone`，装成 App 之后
 * **浏览器那一整条 chrome 都没有了 —— 连返回按钮一起没了**。
 * iOS 上没有系统返回手势可用，于是站内那个只在页首的返回链接
 * 就是唯一的出口，而一篇长文读到底，那个出口在两屏之外。
 *
 * ═════════════════════════════════════════
 * 只在原来那个滚出视野之后才出现
 * ═════════════════════════════════════════
 *
 * 一直挂着的话，它会在页首和那个行内返回链接**同时出现两次**——
 * 同一个动作给两个按钮，人得先想一下它们是不是一回事。
 *
 * 用 IntersectionObserver 观察行内那条自己的位置，不监听 scroll：
 * scroll 每帧都触发，在长帖上会明显掉帧（顶部大标题那条同理，
 * 见 `PageHeader`）。
 *
 * ═════════════════════════════════════════
 * **桌面端整个不出现**
 * ═════════════════════════════════════════
 *
 * 站长：「电脑端的返回按钮会和头像重叠 为啥电脑端要返回按钮呢」
 *
 * 两句都对，而且第二句是根子。上面那整段理由 —— 装成 App 之后
 * 浏览器 chrome 没了、iOS 没有系统返回手势 —— **是手机独有的**。
 * 桌面上有浏览器的返回键、有一直在的侧栏、还有页首那条行内返回，
 * 三个出口都在，这个按钮不解决任何问题。
 *
 * 而它有代价：`left-4` 正落在侧栏底部那块，也就是头像和昵称的位置，
 * 于是它盖在人脸上。这不是「调一下位置」能解决的 ——
 * 侧栏那一列从上到下都是内容，桌面上根本没有一块空地留给它。
 *
 * 所以 `lg:hidden`：不是把它挪开，是它在那儿本来就没有理由。
 */
export function FloatingBack({ href, children }: { href: string; children: React.ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [away, setAway] = useState(false);

  useEffect(() => {
    const node = anchor.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setAway(!entry.isIntersecting), {
      threshold: 0,
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      {/* 行内那条返回链接的位置。inline 且零尺寸，不影响任何排版 */}
      <span ref={anchor} aria-hidden />

      <Link
        href={href}
        /*
         * 藏起来时用 `invisible` 而不是不渲染：
         * 出现和消失才有得过渡，直接挂上/摘掉会是一次生硬的跳变。
         * `pointer-events-none` 保证藏着的时候点不到。
         */
        className={`chrome t-footnote fixed left-4 z-30 lg:hidden inline-flex max-w-[min(60vw,14rem)] items-center gap-0.5 rounded-[var(--radius-pill)] py-2 pl-2 pr-3.5 font-medium text-[var(--accent)] shadow-lg transition-all duration-200 ${
          away ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0"
        }`}
        style={{
          /*
           * 落在底部 Tab Bar **上方**。直接贴 bottom 会压在 Tab Bar 上，
           * 而那正是站长抱怨过的另一种叠加（回复框和底部栏重合）。
           *
           * 具体数值放在 globals.css 的 `--floating-back-bottom` 里：
           * 桌面端要单独覆盖一次（那边没有 Tab Bar，但
           * `--tabbar-height` 本身不会变 0），而媒体查询写不进内联样式。
           */
          bottom: "var(--floating-back-bottom)",
          boxShadow: "0 2px 12px rgb(0 0 0 / 0.12), inset 0 0 0 0.5px var(--separator)",
        }}
        aria-hidden={!away}
        tabIndex={away ? undefined : -1}
      >
        <ChevronLeft className="h-4 w-4 shrink-0" strokeWidth={2.2} aria-hidden />
        <span className="truncate">{children}</span>
      </Link>
    </>
  );
}
