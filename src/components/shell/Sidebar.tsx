"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { Avatar } from "@/components/Avatar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useLiveUnread } from "@/components/notifications/live-store";
import {
  activeNavKey,
  sidebarMoreSections,
  sidebarPrimaryItems,
  type NavItem,
  type NavSection,
} from "@/lib/nav";

import { NavIcon } from "./icons";

/**
 * 桌面侧栏。
 *
 * ─────────────────────────────────────────
 * 一级只放每天点的，其余收进「更多」
 * ─────────────────────────────────────────
 *
 * 之前这里是**把 NAV 全部平铺出来**：一个普通成员看到 12 行、
 * 站长 13 行，分成三组而其中两组没有标题。手机端早就有「更多」了
 * （tab 栏放不下），桌面端因为「地方够」就一直什么都往外摆 ——
 * 地方够不等于该摆，一屏 13 个入口的代价是每天要点的那几个更难找。
 *
 * 现在两端同一套办法：一级 + 「更多」，而「更多」在两端都是
 * **用减法算的**（见 nav.ts 的 sidebarMoreSections / moreSheetSections）。
 * 谁都不维护第二份清单，所以「桌面上摸得到、手机上摸不到」
 * 和它的反面都不会再发生。
 */

/**
 * 一行的长相。链接和「更多」那个按钮共用 —— 两处各写一遍的话，
 * 那个按钮迟早会和它上下的行长得不一样，而那正是「乱」的来源。
 */
const rowClass = (isActive: boolean) =>
  `group flex w-full items-center gap-3 rounded-[var(--radius-control)] px-3 py-2 transition-colors ${
    isActive
      ? "bg-[var(--accent-soft)] text-[var(--accent)]"
      : "text-[var(--ink-secondary)] hover:bg-[var(--fill)] hover:text-[var(--ink)]"
  }`;

function Badge({ count }: { count: number }) {
  return (
    <span className="tabular flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[0.6875rem] font-semibold text-[var(--accent-ink)]">
      {count > 99 ? "99+" : count}
    </span>
  );
}

function NavRow({ item, isActive, count }: { item: NavItem; isActive: boolean; count: number }) {
  return (
    <li>
      <Link href={item.href} aria-current={isActive ? "page" : undefined} className={rowClass(isActive)}>
        <NavIcon
          name={item.icon}
          className="h-[1.125rem] w-[1.125rem] shrink-0"
          strokeWidth={isActive ? 2.1 : 1.75}
        />
        <span className="t-subhead flex-1 font-medium">{item.label}</span>
        {count > 0 && <Badge count={count} />}
      </Link>
    </li>
  );
}

export interface ShellUser {
  name: string;
  wxId: string;
  avatarUrl: string | null;
  level: number;
  points: number;
  roleLabel: string | null;
  roleColor: string | null;
}

export function Sidebar({
  sections,
  user,
  badges = {},
}: {
  sections: NavSection[];
  user: ShellUser | null;
  badges?: Record<string, number>;
}) {
  const pathname = usePathname();
  const active = activeNavKey(pathname);
  // 实时通道给过数就用它，否则用服务端渲染时的值 —— 详见 live-store.ts
  const liveUnread = useLiveUnread();
  const badgeOf = (key: string) =>
    key === "notifications" && liveUnread !== null ? liveUnread : badges[key];

  /*
   * 可见性已经由 AppShell 判完了（权限、登录、功能开关都在服务端过一遍）。
   * 这里只按 key 认人，不重新判一次 —— 判两次必然分叉，
   * 而分叉出来的那一份通常是漏了某个条件的。
   */
  const visibleKeys = new Set(sections.flatMap((s) => s.items.map((i) => i.key)));
  const isVisible = (item: NavItem) => visibleKeys.has(item.key);

  const primary = sidebarPrimaryItems(isVisible);
  const moreSections = sidebarMoreSections(isVisible);

  /*
   * 「更多」默认开着还是收着，看**当前在不在里面**。
   *
   * 人在资源库这一页，而侧栏上「更多」是收起来的话，屏幕上
   * 没有任何一行是高亮的 —— 那种状态下人第一反应是自己迷路了。
   *
   * `null` 表示「还没手动动过」，此时跟着当前位置走；
   * 一旦手动开合过就听手动的。这一整套是渲染期算出来的，
   * 没有 effect、没有在 effect 里 setState。
   */
  const [toggled, setToggled] = useState<boolean | null>(null);
  const activeIsInMore = moreSections.some((s) => s.items.some((i) => i.key === active));
  const moreOpen = toggled ?? activeIsInMore;

  /*
   * 「更多」收起来时，把里面所有条目的未读数加起来显示在它自己那一行上。
   * 不加的话，一条未读会因为它所在的入口被收起来而彻底消失 ——
   * 而红点正是让人回到站里的那个东西。手机端的「更多」是同一个做法。
   */
  const moreBadge = moreSections.reduce(
    (sum, s) => sum + s.items.reduce((n, i) => n + (badgeOf(i.key) ?? 0), 0),
    0,
  );

  return (
    <aside className="hairline-r fixed inset-y-0 left-0 z-30 hidden w-[var(--sidebar-width)] flex-col lg:flex">
      <div className="flex h-16 shrink-0 items-center px-5">
        <Link href="/" className="flex items-center gap-2.5 transition active:scale-[0.98]">
          <span className="flex h-7 w-7 items-center justify-center rounded-[0.5rem] bg-[var(--accent)] text-[0.8125rem] font-bold text-[var(--accent-ink)]">
            AL
          </span>
          <span className="t-headline">Agentic Lab</span>
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        {/* 一级：平铺，不分组 —— 五行不需要目录 */}
        <ul className="space-y-0.5">
          {primary.map((item) => (
            <NavRow
              key={item.key}
              item={item}
              isActive={active === item.key}
              count={badgeOf(item.key) ?? 0}
            />
          ))}
        </ul>

        {moreSections.length > 0 && (
          <div className="mt-5">
            <button
              type="button"
              onClick={() => setToggled(!moreOpen)}
              aria-expanded={moreOpen}
              className={rowClass(false)}
            >
              <NavIcon name="more" className="h-[1.125rem] w-[1.125rem] shrink-0" strokeWidth={1.75} />
              <span className="t-subhead flex-1 text-left font-medium">更多</span>
              {!moreOpen && moreBadge > 0 && <Badge count={moreBadge} />}
              <ChevronDown
                className={`h-4 w-4 shrink-0 transition-transform ${moreOpen ? "rotate-180" : ""}`}
                strokeWidth={2}
                aria-hidden
              />
            </button>

            {moreOpen &&
              moreSections.map((section) => (
                <div key={section.key} className="mt-2">
                  {section.label && <p className="t-group-label mb-1.5 px-3">{section.label}</p>}
                  <ul className="space-y-0.5">
                    {section.items.map((item) => (
                      <NavRow
                        key={item.key}
                        item={item}
                        isActive={active === item.key}
                        count={badgeOf(item.key) ?? 0}
                      />
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        )}
      </nav>

      <div className="shrink-0 space-y-2 p-3">
        <ThemeToggle />
        {user ? (
          <Link
            href="/me"
            className="flex items-center gap-2.5 rounded-[var(--radius-control)] p-2 transition-colors hover:bg-[var(--fill)]"
          >
            <Avatar wxId={user.wxId} name={user.name} src={user.avatarUrl} size={32} />
            <span className="min-w-0 flex-1">
              <span className="t-subhead block truncate font-medium">{user.name}</span>
              <span className="tabular t-caption block text-[var(--ink-tertiary)]">
                L{user.level} · {user.points} 分
              </span>
            </span>
          </Link>
        ) : (
          <Link
            href="/login"
            className="t-subhead flex items-center justify-center rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2.5 font-medium text-[var(--accent-ink)] transition active:scale-[0.98]"
          >
            登录
          </Link>
        )}
      </div>
    </aside>
  );
}
