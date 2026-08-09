"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useLiveUnread } from "@/components/notifications/live-store";
import { activeNavKey, type NavItem, type NavSection } from "@/lib/nav";

import { NavIcon } from "./icons";
import { MoreSheet, type SheetSection } from "./MoreSheet";

/**
 * 移动端底部 Tab Bar。
 *
 * 关键的两处 iOS 规范：
 *   - 高度之外要加 safe-area-inset-bottom，否则在带 Home Indicator 的机型上
 *     最后一行会被横条压住，点不到；
 *   - 每个 tab 的可点区域必须撑满整格高度，不能只有图标那一小块。
 *
 * ─────────────────────────────────────────
 * 最后一格是「更多」，不是第 5 个目的地
 * ─────────────────────────────────────────
 *
 * 之前 5 格全是目的地，剩下的 7 个板块只放在桌面侧栏里 ——
 * 于是通知、资源库、活动、成员、雷达、商店和整个后台
 * **在手机上根本没有入口**。而这个站大部分人是在微信里点开的。
 *
 * 「更多」按未读总数带角标 —— 通知虽然进了弹层，
 * 它的红点仍然一直在 tab 栏上，不会因为「藏进去了」而失联。
 */
export function TabBar({
  items,
  more,
  badges = {},
}: {
  items: NavItem[];
  /** 「更多」里放什么 —— 所有不在 tab 栏里的板块 */
  more: NavSection[];
  badges?: Record<string, number>;
}) {
  const pathname = usePathname();
  const active = activeNavKey(pathname);
  // 实时通道给过数就用它，否则用服务端渲染时的值 —— 详见 live-store.ts
  const liveUnread = useLiveUnread();
  const badgeOf = (key: string) =>
    key === "notifications" && liveUnread !== null ? liveUnread : badges[key];

  if (items.length === 0) return null;

  const moreSections: SheetSection[] = more.map((section) => ({
    key: section.key,
    label: section.label ?? "",
    items: section.items.map((item) => ({
      key: item.key,
      href: item.href,
      label: item.label,
      icon: item.icon,
      badge: badgeOf(item.key),
    })),
  }));

  /*
   * 「更多」上的角标是里面所有条目的**总和**。
   *
   * 不聚合的话，通知的红点会随着它被收进弹层而消失 ——
   * 而红点正是让人回到站里的那个东西。
   */
  const moreBadge = moreSections.reduce(
    (sum, s) => sum + s.items.reduce((n, i) => n + (i.badge ?? 0), 0),
    0,
  );

  return (
    <nav
      className="chrome fixed inset-x-0 bottom-0 z-40 lg:hidden"
      style={{ boxShadow: "inset 0 0.5px 0 var(--separator)" }}
      aria-label="主导航"
    >
      <ul
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${items.length + 1}, minmax(0, 1fr))`,
          height: "var(--tabbar-height)",
        }}
      >
        {items.map((item) => {
          const isActive = active === item.key;
          return (
            <li key={item.key} className="contents">
              <Link
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`flex h-full flex-col items-center justify-center gap-[0.1875rem] transition-colors duration-150 ${
                  isActive ? "text-[var(--accent)]" : "text-[var(--ink-tertiary)]"
                }`}
              >
                <span className="relative">
                  <NavIcon
                    name={item.icon}
                    className="h-[1.375rem] w-[1.375rem]"
                    strokeWidth={isActive ? 2.2 : 1.75}
                  />
                  {badgeOf(item.key) > 0 && (
                    <span
                      className="absolute -right-1.5 -top-0.5 h-[0.4375rem] w-[0.4375rem] rounded-full bg-[var(--accent)]"
                      aria-label={`${badgeOf(item.key)} 条未读`}
                    />
                  )}
                </span>
                <span className="t-caption2 font-medium leading-none">{item.label}</span>
              </Link>
            </li>
          );
        })}

        <li className="contents">
          <MoreSheet
            sections={moreSections}
            trigger={(open, isOpen) => (
              <button
                type="button"
                onClick={open}
                aria-haspopup="dialog"
                aria-expanded={isOpen}
                className={`flex h-full flex-col items-center justify-center gap-[0.1875rem] transition-colors duration-150 ${
                  isOpen ? "text-[var(--accent)]" : "text-[var(--ink-tertiary)]"
                }`}
              >
                <span className="relative">
                  <NavIcon name="more" className="h-[1.375rem] w-[1.375rem]" strokeWidth={1.75} />
                  {moreBadge > 0 && (
                    <span
                      className="absolute -right-1.5 -top-0.5 h-[0.4375rem] w-[0.4375rem] rounded-full bg-[var(--accent)]"
                      aria-label={`${moreBadge} 条未读`}
                    />
                  )}
                </span>
                <span className="t-caption2 font-medium leading-none">更多</span>
              </button>
            )}
          />
        </li>
      </ul>
      <div style={{ height: "env(safe-area-inset-bottom, 0px)" }} />
    </nav>
  );
}
