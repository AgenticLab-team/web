"use client";

/**
 * 首页提示卡的**外壳**。三种提示共用一个形状。
 *
 * ═════════════════════════════════════════
 * 按钮一样大，这不是排版洁癖
 * ═════════════════════════════════════════
 *
 * 原来推送那张卡是「一个实心大按钮 + 一个 32px 的 ×」。
 * 两个问题：
 *
 *   · **一大一小在说「你应该点左边那个」** —— 而这三件事全都是可选的。
 *     用尺寸替人做决定，等于把一个建议做成了半个强制。
 *   · 32px 的 × 低于 44px 触摸下限。拇指按下去有一半概率落空，
 *     而落空的那一半会点到旁边那个实心按钮上 ——
 *     **想关掉它的人反而被推着往前走了一步。**
 *
 * 所以统一成：并排、等高（min-h-11 = 44px）、同一种字号。
 * 只有主操作带一层淡色底，用颜色而不是尺寸表示「这个是主要的」。
 * 这也是 Passkey 那张卡一直在用的形状（它的注释里写着
 * 「把『不用了』做成一行灰色小字，是让人学会无视整块区域最快的办法」）。
 *
 * ═════════════════════════════════════════
 * 它是一张卡片，不是弹窗、不是红点
 * ═════════════════════════════════════════
 *
 * 说的是「你可以做一件事」，不是「你有事没做」。
 * 所以不进通知中心、不带角标、不出现在导航上。
 */

export interface NudgeAction {
  label: string;
  onClick: () => void;
  /** 主操作：带一层淡色底。一张卡里最多一个 */
  primary?: boolean;
  disabled?: boolean;
}

export function NudgeCard({
  icon,
  title,
  body,
  actions,
  error,
}: {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
  actions: NudgeAction[];
  error?: string | null;
}) {
  return (
    <section className="animate-rise inset-group mb-4 px-4 py-3.5">
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--accent)]"
          style={{ background: "color-mix(in srgb, var(--accent) 12%, transparent)" }}
          aria-hidden
        >
          {icon}
        </span>

        <div className="min-w-0 flex-1">
          <p className="t-subhead font-medium">{title}</p>
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">{body}</p>

          {/*
            flex-wrap：窄屏上让按钮自然掉到第二行，
            而不是各自压窄到点不准。
          */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                disabled={action.disabled}
                onClick={action.onClick}
                className={`t-footnote inline-flex min-h-11 items-center rounded-[var(--radius-pill)] px-3.5 transition active:opacity-60 disabled:opacity-45 ${
                  action.primary
                    ? "font-medium text-[var(--accent)]"
                    : "text-[var(--ink-secondary)]"
                }`}
                style={
                  action.primary
                    ? { background: "color-mix(in srgb, var(--accent) 12%, transparent)" }
                    : undefined
                }
              >
                {action.label}
              </button>
            ))}
          </div>

          {error && (
            <p className="t-caption mt-2" style={{ color: "var(--danger)" }}>
              {error}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
