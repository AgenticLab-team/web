"use client";

import {
  Bell,
  Bookmark,
  FileText,
  UserPlus,
  LayoutGrid,
  Calendar,
  Gift,
  FolderGit2,
  Home,
  Link as LinkIcon,
  Mail,
  MessageCircle,
  MessagesSquare,
  Radar,
  Search,
  Shield,
  Trophy,
  KeyRound,
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
  "folder-git-2": FolderGit2,
  more: LayoutGrid,
  bell: Bell,
  trophy: Trophy,
  search: Search,
  "messages-square": MessagesSquare,
  "message-circle": MessageCircle,
  calendar: Calendar,
  users: Users,
  link: LinkIcon,
  radar: Radar,
  "user-round": UserRound,
  shield: Shield,
  gift: Gift,
  bookmark: Bookmark,
  "user-plus": UserPlus,
  "file-text": FileText,
  "key-round": KeyRound,
  mail: Mail,
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
