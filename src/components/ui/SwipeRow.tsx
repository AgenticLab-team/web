"use client";

import { useRef, useState } from "react";

/**
 * 左滑露出操作的行。
 *
 * iOS 里这是删除、归档这类操作的标准手势 —— 比长按菜单快，
 * 也不占用页面空间。几个关键细节：
 *
 *   - **只认水平滑动**：一开始就判断方向，否则用户想上下滚页面
 *     会被这个组件截胡，滚动变得黏手
 *   - **有阻尼**：拉过头时位移递减，而不是硬停或无限拉
 *   - **过半自动吸附**：松手时按位置决定回弹还是展开，
 *     不做「必须滑到底」那种精确要求
 *   - 桌面端不启用：鼠标没有这个心智模型，用悬停按钮更合适
 */

export interface SwipeAction {
  label: string;
  icon: React.ReactNode;
  /** 危险操作用红色 */
  danger?: boolean;
  run: () => void;
}

const ACTION_WIDTH = 72;

export function SwipeRow({
  actions,
  children,
  disabled = false,
}: {
  actions: SwipeAction[];
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const [animating, setAnimating] = useState(false);
  const start = useRef<{ x: number; y: number; base: number } | null>(null);
  const direction = useRef<"none" | "horizontal" | "vertical">("none");

  const maxOffset = actions.length * ACTION_WIDTH;

  if (disabled || actions.length === 0) return <>{children}</>;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") return;
    start.current = { x: e.clientX, y: e.clientY, base: offset };
    direction.current = "none";
    setAnimating(false);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const dx = e.clientX - start.current.x;
    const dy = e.clientY - start.current.y;

    // 先定方向再动。不定方向的话竖滑会被误判成横滑，页面滚不动
    if (direction.current === "none") {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      direction.current = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
      if (direction.current === "vertical") {
        start.current = null;
        return;
      }
    }

    const raw = start.current.base + dx;
    // 阻尼：往右拉（负方向）和拉过头时位移递减
    const clamped =
      raw > 0 ? raw * 0.25 : raw < -maxOffset ? -maxOffset - (-raw - maxOffset) * 0.3 : raw;
    setOffset(clamped);
  };

  const onPointerUp = () => {
    if (!start.current) return;
    start.current = null;
    setAnimating(true);
    // 过半就吸附到展开，否则回弹
    setOffset(offset < -maxOffset / 2 ? -maxOffset : 0);
  };

  return (
    <div className="relative overflow-hidden">
      <div className="absolute inset-y-0 right-0 flex">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={() => {
              action.run();
              setAnimating(true);
              setOffset(0);
            }}
            aria-label={action.label}
            style={{ width: ACTION_WIDTH }}
            /*
             * 前景色跟着底色走，不是一律白字。
             *
             * 暗色下 `--danger` 是浅珊瑚 (#ff7a6b)，白字压上去实测 2.55:1 ——
             * 远低于 4.5:1，那个「删除」两个字基本看不见。
             * `--danger-ink` 在两套配色里各自和它反着来（亮 5.42、暗 7.18）。
             */
            className={`flex flex-col items-center justify-center gap-1 ${
              action.danger
                ? "bg-[var(--danger)] text-[var(--danger-ink)]"
                : "bg-[var(--ink-tertiary)] text-[var(--canvas)]"
            }`}
          >
            {action.icon}
            <span className="t-caption2">{action.label}</span>
          </button>
        ))}
      </div>

      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          transform: `translateX(${offset}px)`,
          // 归位是「已有元素改变位置」——转场档；跟手拖动时必须关掉过渡
          transition: animating ? "transform var(--motion-shift) var(--ease-spring)" : "none",
          // 允许竖向滚动透传，横向由我们接管
          touchAction: "pan-y",
        }}
        className="relative bg-[var(--surface)]"
      >
        {children}
      </div>
    </div>
  );
}
