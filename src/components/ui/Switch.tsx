"use client";

/**
 * iOS 那种拨动开关。
 *
 * ═════════════════════════════════════════
 * 收成构件的理由：它被手写了**七遍**，而且已经开始各写各的了
 * ═════════════════════════════════════════
 *
 * 隐私、通知、导出、称号自动续费、GitHub 绑定、后台模块、功能开关 ——
 * 七处一模一样的 `<button role="switch">` + 一个绝对定位的滑块。
 * （`primitives.tsx` 顶上那条规矩是「重复 ≥6 次才收」，这个正好踩线。）
 *
 * ★ 而它们已经**漂开了**，漂的正好是一个深色 bug：
 *
 *   五处滑块写的是 `bg-white`，两处写的是 `bg-[var(--surface)]`，
 *   而后者旁边留着一句注释 ——「暗色下白滑块亮得像颗灯泡」。
 *
 *   也就是说有人发现了这个问题、在**自己那一处**修好了，
 *   而另外五处至今还亮着。这就是同一个构件抄七遍的实际代价：
 *   修复不会传播，只有 bug 会。
 *
 * ★ 顺带修掉一个七处共有的问题：**命中区只有 31px 高**。
 *
 *   量出来 51×31 —— 拇指要够 44。加 `tap-target` 之后视觉尺寸不变，
 *   而伪元素把可点范围撑到 44（`globals.css` 里那条）。
 *   开关比别的按钮更需要这个：拨错一格的代价是把一个设置反过来，
 *   而人往往要过一会儿才发现。
 */

export function Switch({
  on,
  onToggle,
  label,
  disabled = false,
  /** 通知页那排「推送到设备」用小号 —— 它跟在一行文字后面，大号会把行撑开 */
  size = "md",
  /** 小号那一档用主题色，大号用成功色 —— 沿用原来七处各自的选择 */
  tone,
  className = "",
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
  disabled?: boolean;
  size?: "md" | "sm";
  tone?: "success" | "accent";
  className?: string;
}) {
  const sm = size === "sm";
  const color = tone ?? (sm ? "accent" : "success");

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={`tap-target relative shrink-0 rounded-full transition disabled:opacity-45 ${
        sm ? "h-[22px] w-[38px]" : "h-[31px] w-[51px]"
      } ${className}`}
      style={{ background: on ? `var(--${color})` : "var(--fill-strong, var(--fill))" }}
    >
      {/*
        * 位移走 translateX 不走 left —— 理由见 globals.css 的 .switch-knob。
        * 滑块用 --surface 而不是纯白：暗色下白滑块亮得像颗灯泡。
        */}
      <span
        className={`switch-knob absolute left-[2px] top-[2px] rounded-full bg-[var(--surface)] shadow-sm ${
          sm ? "h-[18px] w-[18px]" : "h-[27px] w-[27px]"
        }`}
        style={{ transform: on ? `translateX(${sm ? 16 : 20}px)` : "translateX(0)" }}
      />
    </button>
  );
}
