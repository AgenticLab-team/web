import { Loader2 } from "lucide-react";
import { buttonClass } from "@/components/ui/primitives";

/**
 * 「开放 API」那几块共用的表单件。
 *
 * ═════════════════════════════════════════
 * 为什么这里要单独有一套，而不是直接手写
 * ═════════════════════════════════════════
 *
 * 站长的原话是「ui 布局都是灾难」。拆开看，这几个组件里最伤人的
 * 不是配色也不是间距，是**节奏不一致**：同一屏上 label 有的是
 * t-caption2 的四级灰、有的是 t-subhead 的正文黑；输入框有的
 * py-2（36px 高）、有的 min-h-11；两个功能一样的按钮，一个是
 * 实心强调色、一个是 12% 的淡底。
 *
 * 每一处单看都「差不多」，合起来就是眼睛一直在重新校准 ——
 * 而这正是「灾难」的实际手感。所以这里把三样东西各定一个出处：
 * 字段、按钮、结果提示。往后加控件只能从这里挑，不能再发明。
 *
 * 放在 components/api/ 下而不是 ui/primitives：这一套的取舍是
 * 「给要动手调接口的人用的密集表单」，和站里那些以阅读为主的
 * 页面不是同一件事，提上去会逼着别的页面也变密。
 */

/**
 * 一个字段。**渲染成真正的 `<label>`**，不是一个 `<div>` 加一行小字。
 *
 * 两个收益都不是理论上的：
 *   · 点标题文字就能聚焦到控件 —— 手机上标题那一行比 44px 的输入框
 *     更容易点中，白白多一块可点区域
 *   · 读屏念得出这个框是干什么的。之前那些 `<label>` 和 `<input>`
 *     只是上下相邻、没有任何关联，读屏念到框时只会说「编辑框」
 */
export function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  /** 一句为什么 / 怎么填。写不出短句就别写 —— 长句在这里会把表单撑散 */
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="t-footnote block font-medium text-[var(--ink-secondary)]">{label}</span>
      {hint && (
        <span className="t-caption mt-0.5 block leading-relaxed text-[var(--ink-tertiary)]">
          {hint}
        </span>
      )}
      <span className="mt-1.5 block">{children}</span>
    </label>
  );
}

/**
 * 输入控件的统一长相。
 *
 * `min-h-11` 是 44px —— 这几页在手机上会被真的用（微信里点开、
 * 粘一把令牌试一下），而 36px 高的框是「点三次中两次」的那一档。
 * 桌面端多出来的 8px 没有任何代价。
 */
export const CONTROL =
  "t-body min-h-11 w-full rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2.5 outline-none placeholder:text-[var(--ink-quaternary)]";

/** 令牌、conv_id、JSON —— 这些东西必须等宽，不然一眼认不出自己粘错了位 */
export const CONTROL_MONO = `${CONTROL} font-mono`;

/*
 * tone 的长相搬到共享层了（`ui/primitives.tsx` 的 `buttonClass`）。
 *
 * 这里原来自成一份三档表，而后台那套 kit **同时**也有一份五档的 ——
 * 两套各自都讲得通，合起来的效果是全站按钮比重构之前更多样。
 * 站长看到的「仍然好乱」就是这个。
 *
 * 危险那一档原来是写在 `style` 里的 color-mix，共享层里叫 `dangerSoft`，
 * 值一样 —— 顺手也把它从内联样式里拿出来了：内联样式压过一切，
 * 以后想统一调深浅时它会是唯一改不动的那个。
 */
const TONE_MAP = {
  primary: "primary",
  quiet: "neutral",
  danger: "dangerSoft",
} as const;

/**
 * 按钮。
 *
 * 只有三档，而且**主行动是实心的**。
 *
 * 之前每个按钮都是「强调色 12% 的淡底 + 强调色文字」——
 * 于是「生成令牌」「发起请求」「真的往群里发」在视觉上一样重，
 * 而其中一条是不可撤销的。实心留给这一屏真正的主行动，
 * 其余降到 quiet，破坏性的确认用 danger。
 */
export function ActionButton({
  tone = "primary",
  busy = false,
  disabled = false,
  onClick,
  icon,
  children,
  className = "",
}: {
  tone?: keyof typeof TONE_MAP;
  /** 进行中：换文案由调用方决定，这里只负责转圈和禁用 */
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={onClick}
      aria-busy={busy || undefined}
      className={buttonClass(TONE_MAP[tone], "md", className)}
    >
      {busy ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={2.4} aria-hidden />
      ) : (
        icon
      )}
      {children}
    </button>
  );
}

const NOTE_COLOR = {
  ok: "var(--success)",
  error: "var(--danger)",
  warn: "var(--warning)",
  info: "var(--accent)",
} as const;

/**
 * 一次操作之后的那句话。
 *
 * ─────────────────────────────────────────
 * 它必须让读屏也知道发生了什么
 * ─────────────────────────────────────────
 *
 * 这几页上的操作全是「点一下，屏幕上某处多出一行字」：
 * 发出去了、撤销了、限流了、400 了。看得见的人扫一眼就知道；
 * 而没有 live region 的话，读屏用户点完之后**什么都不会听到** ——
 * 他会以为按钮没反应，然后再点一次。而「再点一次」在这一页
 * 意味着群里再多一条消息。
 *
 * 失败用 alert（打断当前朗读，因为它要人立刻处理），
 * 成功用 status（读完手上那句再念）。
 */
export function StatusNote({
  tone,
  icon,
  children,
  className = "",
}: {
  tone: keyof typeof NOTE_COLOR;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const color = NOTE_COLOR[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`t-footnote flex items-start gap-2 rounded-[var(--radius-control)] px-3 py-2.5 leading-relaxed ${className}`}
      style={{ background: `color-mix(in srgb, ${color} 12%, transparent)`, color }}
    >
      {icon && (
        <span className="mt-0.5 shrink-0" aria-hidden>
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/**
 * 一块小面板。
 *
 * `inset-group` 的内边距在这几页上曾有 px-3.5 py-3 / px-4 py-3 两派 ——
 * 收敛成一处。标题固定 t-headline：这几块是页面的骨架，
 * 用比正文还小的字当标题会让整页读起来没有层次。
 */
export function Panel({
  title,
  hint,
  action,
  children,
  className = "",
  id,
}: {
  title?: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div id={id} className={`inset-group p-4 ${id ? "scroll-mt-16" : ""} ${className}`}>
      {title && (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="t-headline">{title}</h3>
            {hint && (
              <p className="t-footnote mt-1 leading-relaxed text-[var(--ink-secondary)]">{hint}</p>
            )}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
