import Link from "next/link";

/**
 * 基础构件。刻意做得少而准 —— 每多一个变体，页面之间就多一分不一致的机会。
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
}: {
  label: string;
  value: string | number;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-[var(--radius-card)] p-4 ${
        accent ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "bg-[var(--surface)]"
      }`}
    >
      <p className="tabular t-title1 leading-none">
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
    </div>
  );
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

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="inset-group px-6 py-10 text-center">
      <p className="t-callout text-[var(--ink-secondary)]">{title}</p>
      {hint && <p className="t-footnote mt-1.5 text-[var(--ink-tertiary)]">{hint}</p>}
    </div>
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
      className={`t-footnote rounded-[var(--radius-pill)] px-3 py-1.5 font-medium transition-colors ${
        active
          ? "bg-[var(--ink)] text-[var(--canvas)]"
          : "bg-[var(--fill)] text-[var(--ink-secondary)] hover:bg-[var(--fill-strong)]"
      }`}
    >
      {children}
    </Link>
  );
}
