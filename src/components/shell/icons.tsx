"use client";

import {
  Calendar,
  Home,
  Link as LinkIcon,
  MessagesSquare,
  Search,
  Shield,
  Trophy,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";

/**
 * 导航定义里只存图标名（字符串），组件在这里映射成实际组件。
 * 这样 nav.ts 保持纯数据、可被服务端与测试直接引用，不会因为
 * import 了 React 组件而没法在 Node 测试里加载。
 */
const ICONS: Record<string, LucideIcon> = {
  home: Home,
  trophy: Trophy,
  search: Search,
  "messages-square": MessagesSquare,
  calendar: Calendar,
  users: Users,
  link: LinkIcon,
  "user-round": UserRound,
  shield: Shield,
};

export function NavIcon({
  name,
  className,
  strokeWidth = 1.75,
}: {
  name: string;
  className?: string;
  strokeWidth?: number;
}) {
  const Icon = ICONS[name] ?? Home;
  return <Icon className={className} strokeWidth={strokeWidth} aria-hidden />;
}
