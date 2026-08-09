import { ChevronLeft, Search } from "lucide-react";
import Link from "next/link";
import { Children } from "react";

/**
 * 基础构件。刻意做得少而准 —— 每多一个变体，页面之间就多一分不一致的机会。
 *
 * 2026-08 的普查发现「割裂感」主要不是来自缺构件，而是来自**同一个构件
 * 被各页手写了一遍**：卡片写了 36 次（p-3.5 / p-4 / px-4 py-3 各一派），
 * Pill 横滚条写了 11 次（前后台的负边距还不一样），返回链接写了 12 次
 * （有一处漏了 mt-6）。所以这里补的每一个构件都对应一类 ≥6 次的重复，
 * 不是预防性设计。
 */

export function Section({
  title,
  action,
  children,
  className = "",
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`mb-7 ${className}`}>
      {(title || action) && (
        <div className="mb-2 flex items-end justify-between px-1">
          {title && <h2 className="t-group-label">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** iOS 设置页那种分组列表，层级表达最干净的形式 */
export function Group({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`inset-group ${className}`}>{children}</div>;
}

export function Row({
  href,
  children,
  className = "",
}: {
  href?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const base = `inset-row flex items-center gap-3 px-4 py-3 ${className}`;
  if (href) {
    return (
      <Link href={href} className={`${base} transition-colors hover:bg-[var(--fill)]`}>
        {children}
      </Link>
    );
  }
  return <div className={base}>{children}</div>;
}

export function StatTile({
  label,
  value,
  hint,
  accent = false,
  tone,
  href,
}: {
  label: string;
  value: string | number;
  hint?: string;
  accent?: boolean;
  /**
   * 给数字上警示色。后台曾各自克隆过这个格子只为了把数字染黄
   * （举报页的 Metric、经济页的 Tile、仪表盘的 PendingTile 三份），
   * 三份的字号和内边距都不一样 —— 变体收进来，克隆才会消失。
   */
  tone?: "warning" | "danger";
  /** 数字本身就是入口时（仪表盘的待办数）整格可点，不另造一个链接格子 */
  href?: string;
}) {
  const toneColor =
    tone === "danger" ? "var(--danger)" : tone === "warning" ? "var(--warning)" : undefined;

  const body = (
    <>
      <p className="tabular t-title1 leading-none" style={toneColor ? { color: toneColor } : undefined}>
        {typeof value === "number" ? value.toLocaleString("zh-CN") : value}
      </p>
      <p
        className={`t-footnote mt-2 ${
          accent ? "opacity-80" : "text-[var(--ink-secondary)]"
        }`}
      >
        {label}
      </p>
      {hint && (
        <p className={`t-caption mt-0.5 ${accent ? "opacity-60" : "text-[var(--ink-tertiary)]"}`}>
          {hint}
        </p>
      )}
    </>
  );

  const surface = `rounded-[var(--radius-card)] p-4 ${
    accent ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "bg-[var(--surface)]"
  }`;

  if (href) {
    return (
      <Link href={href} className={`${surface} transition active:scale-[0.98]`}>
        {body}
      </Link>
    );
  }
  return <div className={surface}>{body}</div>;
}

/** 前三名给金银铜，其余用中性色 —— 榜单只有第一名突出会让其他人失去参与感 */
const MEDAL = ["#c9a227", "#9aa0a6", "#a9713f"];

export function RankBadge({ rank }: { rank: number }) {
  const medal = rank <= 3 ? MEDAL[rank - 1] : null;
  return (
    <span
      className="tabular flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[0.8125rem] font-semibold"
      style={
        medal
          ? { background: medal, color: "#fff" }
          : { color: "var(--ink-tertiary)" }
      }
    >
      {rank}
    </span>
  );
}

export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  /**
   * 空态常常有一个出口（登录、去设置）。没有这个槽位的时候，
   * 各页就自己拼「inset-group + 居中 + 按钮」—— 普查时同一个登录块
   * 手写了 6 遍，py-10 / py-8 / py-7 三种内边距。
   */
  action?: React.ReactNode;
}) {
  return (
    <div className="inset-group px-6 py-10 text-center">
      <p className="t-callout text-[var(--ink-secondary)]">{title}</p>
      {hint && <p className="t-footnote mx-auto mt-1.5 max-w-sm text-[var(--ink-tertiary)]">{hint}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

/**
 * 空态里的主行动（基本上都是「登录」）。样式固定 ——
 * 它出现在 6 个页面上，之前每处的 padding 和缩放反馈都不一样。
 * min-h-11 = 44px：这个按钮几乎只在手机上被点（微信内置浏览器），
 * 差 4px 的可点高度没人会报告，只会觉得「有点难点中」。
 */
export function EmptyAction({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="t-subhead inline-flex min-h-11 items-center rounded-[var(--radius-control)] bg-[var(--accent)] px-5 font-medium text-[var(--accent-ink)] transition active:scale-[0.97]"
    >
      {children}
    </Link>
  );
}

export function Pill({
  active,
  children,
  href,
}: {
  active?: boolean;
  children: React.ReactNode;
  href: string;
}) {
  return (
    <Link
      href={href}
      /*
       * `inline-flex` 不是为了排版好看，是**必需的**。
       *
       * `<a>` 默认是 `display: inline`。一个 inline 元素里放进任何块级子元素
       * （比如一个 `flex` 的 span），排版引擎会把这个 inline 盒子**劈成三段**：
       * 子元素之前的一段、子元素本身、子元素之后的一段。
       * 而圆角和背景是按段画的 —— 于是屏幕上出现
       * 「左边半圆 / 中间文字 / 右边半圆」三行。
       *
       * 顺带解决另一件事：inline 元素的垂直 padding 不参与行高计算，
       * 所以 `py-1.5` 在原来那个写法下根本撑不开药丸。
       */
      className={`t-footnote inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-3 py-1.5 font-medium transition-colors ${
        active
          ? "bg-[var(--ink)] text-[var(--canvas)]"
          : "bg-[var(--fill)] text-[var(--ink-secondary)] hover:bg-[var(--fill-strong)]"
      }`}
    >
      {children}
    </Link>
  );
}

/**
 * 一排 Pill 的容器。
 *
 * 默认横向滚动并在窄屏上出血到屏幕边缘 —— 群名、版块这类列表长度
 * 不受控，换行的话第三行以后就把内容顶出首屏了。
 * 滚动条整条不画（.no-scrollbar）：「还能往右滑」由内容在边缘被切一半
 * 来表达，比一条横线准确得多。
 * `wrap` 给数量有上限的筛选（排序方式、状态）用：桌面上换行比滚动好点。
 *
 * 每个孩子包一层 shrink-0 —— 不包的话 flex 会把 Pill 压扁而不是让容器滚，
 * 之前 11 处手写里有一半是靠每页自己记得写 <span className="shrink-0"> 保命的。
 */
export function PillRow({
  children,
  wrap = false,
  className = "",
}: {
  children: React.ReactNode;
  wrap?: boolean;
  className?: string;
}) {
  const base = wrap
    ? "mb-3 flex flex-wrap gap-1.5"
    // no-scrollbar：一排 30px 高的药丸底下压一条横条，看起来就是根下划线
    : "no-scrollbar -mx-4 mb-3 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0";
  return (
    <div className={`${base} ${className}`}>
      {Children.map(children, (child) =>
        child === null || child === undefined || child === false ? (
          child
        ) : (
          <span className="shrink-0">{child}</span>
        ),
      )}
    </div>
  );
}

/**
 * 白底卡片。这是普查里手写次数最多的东西（36 处），
 * 内边距分裂成 p-3.5 / p-4 / px-4 py-3 三派 —— 统一成 p-4。
 * 需要语义标签（列表项用 article）就传 as，不要回去手拼 className。
 */
export function Card({
  children,
  as: Tag = "div",
  className = "",
  style,
}: {
  children: React.ReactNode;
  as?: "div" | "article" | "section";
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <Tag className={`rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline ${className}`} style={style}>
      {children}
    </Tag>
  );
}

const CALLOUT_TONES = {
  neutral: null,
  accent: "var(--accent)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
} as const;

/**
 * 页面顶部的提示横幅（存储要满了、有备份没验证、赛季还剩几天）。
 *
 * 之前每页自己写 color-mix，混合比例 7% ~ 10% 随手挑，
 * admin/health 还长出过一个局部同名组件 —— 现在染色只在这一处发生。
 * 标题染 tone 色、正文保持中性：整块都染色的话，两个横幅叠在一起
 * 就成了警报墙，反而没有人细看。
 */
export function Callout({
  tone = "neutral",
  title,
  icon,
  children,
  className = "",
}: {
  tone?: keyof typeof CALLOUT_TONES;
  title?: React.ReactNode;
  icon?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  const color = CALLOUT_TONES[tone];
  const inner = (
    <div className="min-w-0 flex-1">
      {title && (
        <p className="t-subhead font-medium" style={color ? { color } : undefined}>
          {title}
        </p>
      )}
      {children}
    </div>
  );
  return (
    <div
      className={`mb-4 rounded-[var(--radius-card)] p-4 hairline ${icon ? "flex gap-2.5" : ""} ${className}`}
      style={{
        background: color ? `color-mix(in srgb, ${color} 9%, var(--surface))` : "var(--surface)",
      }}
    >
      {icon ? (
        <>
          <span className="mt-0.5 shrink-0" style={color ? { color } : undefined} aria-hidden>
            {icon}
          </span>
          {inner}
        </>
      ) : (
        inner
      )}
    </div>
  );
}

/**
 * 子页面顶部的返回链接。手写过 12 次，第 12 次（用户详情页）漏了 mt-6，
 * 于是那一页的标题比别的子页高出 1.5rem —— 这种差异没人会报告，只会觉得怪。
 */
export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="t-subhead -ml-1 mt-6 inline-flex items-center gap-0.5 text-[var(--accent)] transition active:opacity-60"
    >
      <ChevronLeft className="h-4 w-4" strokeWidth={2.2} aria-hidden />
      {children}
    </Link>
  );
}

/**
 * 页尾的说明段（这页数据从哪来、什么看不到、为什么）。
 * 间距固定 mt-4 / pb-4 —— 之前 14 处里 mt 有四种，有的直接贴着列表。
 * 需要带图标时传 className="flex gap-1.5"。
 */
export function PageNote({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={`t-caption mt-4 px-1 pb-4 leading-relaxed text-[var(--ink-tertiary)] ${className}`}>
      {children}
    </p>
  );
}

/**
 * 搜索输入框。表单（action、隐藏参数）留在页面里，这里只管长相 ——
 * 之前一半页面用 fill 底无边框、另一半用 surface 底加发丝线，
 * 同一个站里的两个搜索框长得不一样，比任何一种都糟。
 */
export function SearchField({
  name = "q",
  defaultValue,
  placeholder,
  autoFocus,
}: {
  name?: string;
  defaultValue?: string;
  placeholder: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 rounded-[var(--radius-card)] bg-[var(--surface)] px-4 py-3 hairline">
      <Search className="h-4 w-4 shrink-0 text-[var(--ink-tertiary)]" strokeWidth={2} aria-hidden />
      <input
        type="search"
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        autoFocus={autoFocus}
        enterKeyHint="search"
        className="t-body w-full bg-transparent outline-none placeholder:text-[var(--ink-quaternary)]"
      />
    </div>
  );
}
