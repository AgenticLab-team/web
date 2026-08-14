import { AlignLeft, ListTree } from "lucide-react";
import Link from "next/link";

import type { ViewMode } from "@/lib/forum/thread-rules";

/**
 * 平铺 / 楼中楼 的切换。
 *
 * ─────────────────────────────────────────
 * 没有嵌套的时候整个不出现
 * ─────────────────────────────────────────
 *
 * 一条嵌套都没有的帖子，两种视图**长得一模一样** ——
 * 摆一个切换按钮在那儿，点了什么都不变，
 * 人第一反应是这个站坏了，第二反应是不再点这个站的任何按钮。
 *
 * 判据在 `threadingIsMeaningful`：至少有一条回复的父级也在这一页上。
 *
 * ─────────────────────────────────────────
 * 走链接，不走客户端状态
 * ─────────────────────────────────────────
 *
 * 视图写在地址里（`?view=`），于是它能被收藏、能被贴进群里 ——
 * 「你看这条对话的树」发出去之后对方看到的和你一样。
 * 存在客户端状态里的话，那条链接打开是另一个样子。
 */
export function ThreadToggle({
  postId,
  current,
  /** 版块的默认视图 —— 和默认一致时不带参数，链接干净一点 */
  boardDefault,
}: {
  postId: string;
  current: ViewMode;
  boardDefault: ViewMode;
}) {
  const href = (mode: ViewMode) =>
    mode === boardDefault ? `/forum/p/${postId}` : `/forum/p/${postId}?view=${mode}`;

  return (
    <div
      className="mb-3 inline-flex rounded-[var(--radius-pill)] bg-[var(--fill)] p-0.5"
      role="group"
      aria-label="回复的排列方式"
    >
      <Option href={href("flat")} active={current === "flat"} icon={AlignLeft} label="平铺" />
      <Option
        href={href("threaded")}
        active={current === "threaded"}
        icon={ListTree}
        label="楼中楼"
      />
    </div>
  );
}

function Option({
  href,
  active,
  icon: Icon,
  label,
}: {
  href: string;
  active: boolean;
  icon: typeof AlignLeft;
  label: string;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? "true" : undefined}
      className={`tap-target t-caption inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-2.5 py-1 font-medium transition ${
        active
          ? "bg-[var(--surface)] text-[var(--ink)] shadow-sm"
          : "text-[var(--ink-tertiary)] hover:text-[var(--ink-secondary)]"
      }`}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
      {label}
    </Link>
  );
}
