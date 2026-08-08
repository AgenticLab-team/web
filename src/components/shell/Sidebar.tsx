"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Avatar } from "@/components/Avatar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { activeNavKey, type NavSection } from "@/lib/nav";

import { NavIcon } from "./icons";

export interface ShellUser {
  name: string;
  wxId: string;
  avatarUrl: string | null;
  level: number;
  points: number;
  roleLabel: string | null;
  roleColor: string | null;
}

export function Sidebar({ sections, user }: { sections: NavSection[]; user: ShellUser | null }) {
  const pathname = usePathname();
  const active = activeNavKey(pathname);

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
        {sections.map((section) => (
          <div key={section.key} className="mb-5">
            {section.label && (
              <p className="t-group-label mb-1.5 px-3">{section.label}</p>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const isActive = active === item.key;
                return (
                  <li key={item.key}>
                    <Link
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
                      className={`group flex items-center gap-3 rounded-[var(--radius-control)] px-3 py-2 transition-colors duration-150 ${
                        isActive
                          ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                          : "text-[var(--ink-secondary)] hover:bg-[var(--fill)] hover:text-[var(--ink)]"
                      }`}
                    >
                      <NavIcon
                        name={item.icon}
                        className="h-[1.125rem] w-[1.125rem] shrink-0"
                        strokeWidth={isActive ? 2.1 : 1.75}
                      />
                      <span className="t-subhead font-medium">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
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
