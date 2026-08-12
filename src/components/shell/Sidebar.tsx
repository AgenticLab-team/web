"use client";

import { ChevronDown, LogIn } from "lucide-react";
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
import { SidebarToggle } from "./SidebarToggle";

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
 *
 * `min-h-11` 是 44px。收起之后这一行只剩一个图标，而窄栏的宽度
 * 正是按「容得下 44px 的点击区」定的 —— 高度不跟上的话，
 * 那个目标是 68×36，横竖不一样大，鼠标划过去的手感就是歪的。
 *
 * 第三档 `contains` 是给「更多」那一行的：当前页在它里面时，
 * 它自己也要认领一下。收起之后展开层整个 display:none，
 * 没有这一档的话侧栏上一行亮着的都没有 —— 那种状态下人的第一反应
 * 是自己迷路了。但它只染字色、不铺底色，免得和真正选中的那一行抢。
 */
const rowClass = (state: "idle" | "active" | "contains") =>
  `sidebar-row group relative flex min-h-11 w-full items-center gap-3 rounded-[var(--radius-control)] px-3 py-2 transition-colors ${
    state === "active"
      ? "bg-[var(--accent-soft)] text-[var(--accent)]"
      : state === "contains"
        ? "text-[var(--accent)] hover:bg-[var(--fill)]"
        : "text-[var(--ink-secondary)] hover:bg-[var(--fill)] hover:text-[var(--ink)]"
  }`;

function Badge({ count }: { count: number }) {
  return (
    <span className="sidebar-badge tabular flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[0.6875rem] font-semibold text-[var(--accent-ink)]">
      {count > 99 ? "99+" : count}
      {/* 收起之后这里只剩一个没有数字的点，读屏得靠这句话知道它是什么 */}
      <span className="sr-only"> 条未读</span>
    </span>
  );
}

function NavRow({ item, isActive, count }: { item: NavItem; isActive: boolean; count: number }) {
  return (
    <li>
      <Link
        href={item.href}
        aria-current={isActive ? "page" : undefined}
        /* 收起后图标是唯一线索 —— 悬停总得说得出这是哪一页 */
        title={item.label}
        className={rowClass(isActive ? "active" : "idle")}
      >
        <NavIcon
          name={item.icon}
          className="h-[1.125rem] w-[1.125rem] shrink-0"
          strokeWidth={isActive ? 2.1 : 1.75}
        />
        <span className="sidebar-label t-subhead flex-1 font-medium">{item.label}</span>
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
   * 「更多」那一行上挂着里面所有条目的未读数之和。
   *
   * **不看展开状态**，一直挂着。原来写的是「收起时才显示」，
   * 那在窄栏下是错的：窄栏把整个展开层 display:none 了，而 React 这边
   * 的 `moreOpen` 仍然可能是 true —— 于是那条未读两边都不显示，
   * 彻底消失。而红点正是让人回到站里的那个东西。
   *
   * 代价是展开状态下父子两行可能各带一个数字，那读起来是
   * 「这里面有 3 条，在通知那一项」—— 重复，但不会错。
   * 手机端的「更多」是同一个做法。
   */
  const moreBadge = moreSections.reduce(
    (sum, s) => sum + s.items.reduce((n, i) => n + (badgeOf(i.key) ?? 0), 0),
    0,
  );

  return (
    <aside className="hairline-r fixed inset-y-0 left-0 z-30 hidden w-[var(--sidebar-width)] flex-col lg:flex">
      {/*
        * 收起后这一行只剩两个东西：AL 那个方块和收起按钮，
        * 于是改成竖排居中 —— 4rem 宽里横着摆两个 44px 的目标放不下。
        */}
      <div className="sidebar-head flex h-16 shrink-0 items-center justify-between gap-1 px-5">
        <Link
          href="/"
          title="Agentic Lab"
          className="sidebar-row flex min-w-0 items-center gap-2.5 transition active:scale-[0.98]"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-chip)] bg-[var(--accent)] text-[0.8125rem] font-bold text-[var(--accent-ink)]">
            AL
          </span>
          <span className="sidebar-label t-headline truncate">Agentic Lab</span>
        </Link>
        <SidebarToggle />
      </div>

      {/* 和手机端 Tab Bar 同一个名字：两端只有一个会在场（另一个是 display:none），
          读屏里永远只听得到一个「主导航」 */}
      <nav aria-label="主导航" className="flex-1 overflow-y-auto px-3 pb-4">
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
              title="更多"
              className={rowClass(activeIsInMore ? "contains" : "idle")}
            >
              <NavIcon name="more" className="h-[1.125rem] w-[1.125rem] shrink-0" strokeWidth={1.75} />
              <span className="sidebar-label t-subhead flex-1 text-left font-medium">更多</span>
              {moreBadge > 0 && <Badge count={moreBadge} />}
              <ChevronDown
                className={`sidebar-chevron h-4 w-4 shrink-0 transition-transform ${moreOpen ? "rotate-180" : ""}`}
                strokeWidth={2}
                aria-hidden
              />
            </button>

            {moreOpen &&
              moreSections.map((section) => (
                <div key={section.key} className="sidebar-more-panel mt-2">
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

      {/*
        * 底下这一块钉住不滚。加一条发丝线是因为导航是可滚的 ——
        * 没有线的话，滚到一半的最后一行会和头像那块糊在一起，
        * 看起来像列表还能往下滚，其实下面是另一块东西。
        */}
      <div className="sidebar-foot hairline-t shrink-0 space-y-2 p-3">
        <div className="sidebar-theme">
          <ThemeToggle />
        </div>
        {user ? (
          <Link
            href="/me"
            title={user.name}
            className="sidebar-row flex items-center gap-2.5 rounded-[var(--radius-control)] p-2 transition-colors hover:bg-[var(--fill)]"
          >
            <Avatar wxId={user.wxId} name={user.name} src={user.avatarUrl} size={32} />
            <span className="sidebar-label min-w-0 flex-1">
              <span className="t-subhead block truncate font-medium">{user.name}</span>
              <span className="tabular t-caption block text-[var(--ink-tertiary)]">
                L{user.level} · {user.points} 分
              </span>
            </span>
          </Link>
        ) : (
          <Link
            href="/login"
            title="登录"
            className="sidebar-row t-subhead flex items-center justify-center rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2.5 font-medium text-[var(--accent-ink)] transition active:scale-[0.98]"
          >
            {/*
              * 「登录」两个字在 4rem 宽里会把按钮撑破，所以窄栏下换成图标。
              * 两个都渲染、由 CSS 决定露哪个 —— 换树会在加载时闪。
              */}
            <span className="sidebar-label">登录</span>
            <LogIn className="sidebar-rail-only h-[1.125rem] w-[1.125rem]" strokeWidth={2} aria-hidden />
          </Link>
        )}
      </div>
    </aside>
  );
}
