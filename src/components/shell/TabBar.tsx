"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { activeNavKey, type NavItem } from "@/lib/nav";

import { NavIcon } from "./icons";

/**
 * 移动端底部 Tab Bar。
 *
 * 关键的两处 iOS 规范：
 *   - 高度之外要加 safe-area-inset-bottom，否则在带 Home Indicator 的机型上
 *     最后一行会被横条压住，点不到；
 *   - 每个 tab 的可点区域必须撑满整格高度，不能只有图标那一小块。
 */
export function TabBar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const active = activeNavKey(pathname);

  if (items.length === 0) return null;

  return (
    <nav
      className="chrome fixed inset-x-0 bottom-0 z-40 lg:hidden"
      style={{ boxShadow: "inset 0 0.5px 0 var(--separator)" }}
      aria-label="主导航"
    >
      <ul
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))`,
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
                <NavIcon
                  name={item.icon}
                  className="h-[1.375rem] w-[1.375rem]"
                  strokeWidth={isActive ? 2.2 : 1.75}
                />
                <span className="t-caption2 font-medium leading-none">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      <div style={{ height: "env(safe-area-inset-bottom, 0px)" }} />
    </nav>
  );
}
