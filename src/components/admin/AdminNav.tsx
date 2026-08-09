"use client";

import {
  Activity, CloudUpload, Coins, Eye, FileText, Filter, Flag, Gauge, Gift, HardDrive, LayoutList,
  Megaphone, MessageSquare, Puzzle, Scale, ScrollText, Shield, ShieldCheck, ShoppingBag, Sliders,
  Ticket, Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import type { AdminNavSection } from "@/lib/admin/nav";

const ICONS: Record<string, LucideIcon> = {
  gauge: Gauge,
  "scroll-text": ScrollText,
  users: Users,
  shield: Shield,
  ticket: Ticket,
  flag: Flag,
  scale: Scale,
  "layout-list": LayoutList,
  coins: Coins,
  "message-square": MessageSquare,
  megaphone: Megaphone,
  sliders: Sliders,
  "shield-check": ShieldCheck,
  puzzle: Puzzle,
  filter: Filter,
  eye: Eye,
  "file-text": FileText,
  gift: Gift,
  "shopping-bag": ShoppingBag,
  activity: Activity,
  "hard-drive": HardDrive,
  "cloud-upload": CloudUpload,
};

/**
 * 后台导航。
 *
 * 未实现的入口显示成灰色且不可点，而不是直接隐藏 ——
 * 后台的使用者是管理员，让他知道「这块正在做」比装作不存在有用。
 * 前台则相反：普通用户不需要知道我们的施工进度。
 */
export function AdminNav({ sections }: { sections: AdminNavSection[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="后台导航" className="space-y-5">
      {sections.map((section) => (
        <div key={section.key}>
          <p className="t-group-label mb-1.5 px-1">{section.label}</p>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const Icon = ICONS[item.icon] ?? Gauge;
              const active =
                item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);

              if (!item.ready) {
                return (
                  <li key={item.key}>
                    <span
                      className="flex cursor-default items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2 opacity-40"
                      title="正在做"
                    >
                      <Icon
                        className="h-[1.0625rem] w-[1.0625rem] shrink-0"
                        strokeWidth={1.75}
                        aria-hidden
                      />
                      <span className="t-subhead flex-1">{item.label}</span>
                      <span className="t-caption2">待建</span>
                    </span>
                  </li>
                );
              }

              return (
                <li key={item.key}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2 transition-colors ${
                      active
                        ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                        : "text-[var(--ink-secondary)] hover:bg-[var(--fill)] hover:text-[var(--ink)]"
                    }`}
                  >
                    <Icon
                      className="h-[1.0625rem] w-[1.0625rem] shrink-0"
                      strokeWidth={active ? 2.1 : 1.75}
                      aria-hidden
                    />
                    <span className="t-subhead flex-1 font-medium">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
