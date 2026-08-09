"use client";

import { Clock } from "lucide-react";
import { useEffect, useState } from "react";

import { formatLeft, isUrgent, tickInterval } from "@/lib/activities/countdown";

/**
 * 距离活动结束还有多久。
 *
 * ─────────────────────────────────────────
 * 秒只在最后一小时里跳
 * ─────────────────────────────────────────
 *
 * 文案和刷新频率的规则都在 lib/activities/countdown.ts ——
 * 放在这个客户端组件里的话，测试跑在 react-server 条件下
 * 一 import 就炸（react.createContext is not a function）。
 */
export function Countdown({ endsAt, label = "距结束" }: { endsAt: number; label?: string }) {
  /*
   * 初值给 null，第一帧不渲染时间。
   *
   * 服务端渲染时算出来的「还剩 2 小时 13 分」和客户端补水那一刻
   * 已经不一样了 —— 直接算会 hydration 报错，而且首屏那个数字
   * 本来就是错的。
   */
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setLeft(endsAt - Date.now());
    tick();

    // 一小时以内按秒跳，之外按分钟 —— 三天倒计时里跳秒是假的紧迫感
    const id = setInterval(tick, tickInterval(endsAt - Date.now()));
    return () => clearInterval(id);
  }, [endsAt]);

  if (left === null) {
    // 占位用一个等宽的空行，免得数字出来时整块往下跳
    return <p className="t-caption h-4 text-[var(--ink-tertiary)]" aria-hidden />;
  }

  if (left <= 0) {
    return <p className="t-caption text-[var(--ink-tertiary)]">已经结束</p>;
  }

  const urgent = isUrgent(left);

  return (
    <p
      className="t-caption flex items-center gap-1 tabular"
      style={{ color: urgent ? "var(--warning)" : "var(--ink-tertiary)" }}
      // 每秒都念一遍会把读屏软件变成噪音源
      aria-live="off"
    >
      <Clock className="h-3 w-3 shrink-0" strokeWidth={2.2} aria-hidden />
      {label} {formatLeft(left)}
    </p>
  );
}
