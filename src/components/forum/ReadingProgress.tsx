"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * 一屏半以内不画进度条 —— 那种长度里它是在回答一个没人问的问题，
 * 而它会一直占着视线最上面那一行。
 */
function isLongEnough(): boolean {
  return document.documentElement.scrollHeight > window.innerHeight * 1.5;
}

/**
 * 页面长度会变（图片加载完、回复展开），所以要订阅。
 *
 * resize 收得到窗口变化；ResizeObserver 收得到内容自己变长 ——
 * 只订 resize 的话，一篇图多的帖子在图片加载完之前量出来是短的，
 * 而那正是它最需要进度条的时候。
 */
function subscribeResize(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  const observer = new ResizeObserver(onChange);
  observer.observe(document.body);
  return () => {
    window.removeEventListener("resize", onChange);
    observer.disconnect();
  };
}

/**
 * 阅读进度。顶上一条极细的线 + 滚动时浮出来的楼层号。
 *
 * ─────────────────────────────────────────
 * 长帖里「我在哪」是个真问题
 * ─────────────────────────────────────────
 *
 * 一个两百楼的帖子，滚动条那点长度已经表达不了位置了 ——
 * 而人真正想知道的也不是百分比，是**第几楼**：
 * 楼层是这个页面里唯一能拿去引用、去对话的坐标。
 *
 * 所以两样都给：一条线回答「还剩多少」，一个数字回答「我在哪」。
 *
 * ─────────────────────────────────────────
 * 短帖里一个字都不出现
 * ─────────────────────────────────────────
 *
 * 一屏半就能看完的帖子挂一条进度条，是在给一个不存在的问题
 * 提供答案 —— 而它会一直在那儿，占着视线最上面那一行。
 *
 * ─────────────────────────────────────────
 * 楼层号只在滚的时候露出来
 * ─────────────────────────────────────────
 *
 * 常驻的话，读一段静止的文字时眼角一直挂着一个数字。
 * 停下来一秒就淡出 —— 那时候人在读，不在找路。
 */
export function ReadingProgress({ maxFloor }: { maxFloor: number }) {
  const [pct, setPct] = useState(0);
  const [floor, setFloor] = useState(0);
  const [scrolling, setScrolling] = useState(false);
  /*
   * 值不值得画，要量过才知道 —— 得等浏览器里真的排好版。
   *
   * 用 useSyncExternalStore 而不是 effect 里 setState：后者是
   * 「effect 体内同步 setState」，会多一轮渲染，也正是 React 编译器
   * 要拦的写法。这个 hook 就是为「读一个 React 之外的值、
   * 而且服务端和客户端答案不同」准备的。
   */
  const enabled = useSyncExternalStore(subscribeResize, isLongEnough, () => false);

  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ticking = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const floors = Array.from(document.querySelectorAll<HTMLElement>("[id^='f']")).filter((el) =>
      /^f\d+$/.test(el.id),
    );

    const update = () => {
      ticking.current = false;

      const doc = document.documentElement;
      const total = doc.scrollHeight - window.innerHeight;
      setPct(total > 0 ? Math.min(100, Math.max(0, (window.scrollY / total) * 100)) : 0);

      /*
       * 当前楼层 = 视口上缘往下三分之一处那一楼。
       *
       * 取视口正中的话，翻到底部时会指向倒数第二楼；
       * 取上缘则会在两楼交界处来回跳。三分之一是「眼睛正在看的地方」。
       */
      const line = window.innerHeight / 3;
      let current = 0;
      for (const el of floors) {
        if (el.getBoundingClientRect().top <= line) current = Number(el.id.slice(1));
        else break;
      }
      setFloor(current);
    };

    const onScroll = () => {
      setScrolling(true);
      clearTimeout(idleTimer.current);
      // 停一秒就当人开始读了，把楼层号收起来
      idleTimer.current = setTimeout(() => setScrolling(false), 1000);

      // rAF 节流：滚动事件一秒几十次，每次都算一遍布局会掉帧
      if (ticking.current) return;
      ticking.current = true;
      requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      clearTimeout(idleTimer.current);
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <>
      {/*
        * 进度线。
        *
        * aria-hidden —— 它是纯装饰：读屏用户按标题和地标跳转，
        * 一个每次滚动都变的百分比对他们只是噪音。
        * 真正的坐标（楼层锚点）本来就在 DOM 里。
        */}
      <div
        className="pointer-events-none fixed inset-x-0 top-0 z-40 h-0.5"
        aria-hidden
      >
        <div
          className="h-full origin-left bg-[var(--accent)] transition-[width] duration-150 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      {maxFloor > 0 && (
        <div
          className={`pointer-events-none fixed bottom-20 left-1/2 z-40 -translate-x-1/2 transition-opacity duration-300 sm:bottom-6 ${
            scrolling && floor > 0 ? "opacity-100" : "opacity-0"
          }`}
          aria-hidden
        >
          <span className="tabular t-caption rounded-[var(--radius-pill)] bg-[var(--ink)] px-2.5 py-1 font-medium text-[var(--canvas)] shadow-lg">
            {floor} / {maxFloor}
          </span>
        </div>
      )}
    </>
  );
}
