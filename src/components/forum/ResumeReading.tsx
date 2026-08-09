"use client";

import { CornerRightDown } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { markReadFloor } from "@/lib/forum/actions";

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/**
 * 「跳回上次读到的楼层」+ 阅读进度上报。
 *
 * 长帖回来从头再翻一遍是最劝退的事之一。进度**只前进不后退**
 * （服务端用 MAX 保证），所以这里不用担心往回翻会毁掉进度。
 *
 * 上报节流成每 4 秒最多一次：滚动事件每秒几十次，
 * 每次都发 server action 等于把滚动条变成压测工具。
 */
export function ResumeReading({
  postId,
  lastReadFloor,
  maxFloor,
}: {
  postId: string;
  lastReadFloor: number;
  maxFloor: number;
}) {
  const [dismissed, setDismissed] = useState(false);
  // hash 是浏览器状态，SSR 读不到 —— 用 useSyncExternalStore 而不是
  // effect 里 setState，服务端快照给 false，水合后 React 自己补一轮
  const hasHash = useSyncExternalStore(
    subscribeHash,
    () => Boolean(window.location.hash),
    () => false,
  );
  const seen = useRef(0);
  const sent = useRef(lastReadFloor);

  useEffect(() => {
    const floors = Array.from(document.querySelectorAll<HTMLElement>("[id^='f']")).filter((el) =>
      /^f\d+$/.test(el.id),
    );
    if (floors.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const floor = Number(entry.target.id.slice(1));
          if (floor > seen.current) seen.current = floor;
        }
      },
      { threshold: 0.5 },
    );
    for (const el of floors) observer.observe(el);

    const flush = () => {
      if (seen.current > sent.current) {
        sent.current = seen.current;
        // 静默失败即可 —— 进度丢一次没有任何后果，弹错误反而打扰
        void markReadFloor(postId, seen.current);
      }
    };
    const timer = setInterval(flush, 4000);
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHide);

    return () => {
      observer.disconnect();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, [postId]);

  // 已经读完的、或刚点着锚点进来的，不用再提示
  const showResume = !dismissed && !hasHash && lastReadFloor >= 2 && lastReadFloor < maxFloor;

  if (!showResume) return null;

  return (
    <button
      type="button"
      onClick={() => {
        setDismissed(true);
        document.getElementById(`f${lastReadFloor}`)?.scrollIntoView({ behavior: "smooth" });
      }}
      className="t-footnote mb-3 inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--accent-soft)] px-3 py-1.5 font-medium text-[var(--accent)] transition active:scale-95"
    >
      <CornerRightDown className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
      上次读到 #{lastReadFloor}，点击跳回
    </button>
  );
}
