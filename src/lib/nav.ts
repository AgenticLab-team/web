import type { PermissionKey } from "@/lib/rbac/permissions";

/**
 * 导航是**单一真源**：移动端底部 Tab Bar 与桌面端侧边栏读同一份定义。
 * 两处各写一遍必然会不一致 —— 加了新页面只在一边出现是最常见的返工来源。
 */

export interface NavItem {
  key: string;
  href: string;
  label: string;
  /** lucide 图标名，在组件里映射成具体组件 */
  icon: string;
  /** 需要此权限才显示；不填则所有人可见 */
  permission?: PermissionKey;
  /** 出现在移动端底部 Tab Bar 里（最多 5 个，超了就装不下） */
  inTabBar?: boolean;
  /** 尚未实现的入口先不显示，但保留定义，免得漏掉 */
  ready?: boolean;
}

export interface NavSection {
  key: string;
  label?: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    key: "main",
    items: [
      { key: "home", href: "/", label: "首页", icon: "home", inTabBar: true, ready: true },
      {
        key: "leaderboard",
        href: "/leaderboard",
        label: "排行",
        icon: "trophy",
        inTabBar: true,
        ready: true,
      },
      {
        key: "search",
        href: "/search",
        label: "检索",
        icon: "search",
        permission: "group.messages.read",
        inTabBar: true,
        ready: false,
      },
      {
        key: "forum",
        href: "/forum",
        label: "论坛",
        icon: "messages-square",
        permission: "forum.view",
        ready: false,
      },
    ],
  },
  {
    key: "community",
    label: "社区",
    items: [
      { key: "events", href: "/events", label: "活动", icon: "calendar", ready: false },
      { key: "members", href: "/members", label: "成员", icon: "users", ready: false },
      { key: "links", href: "/links", label: "资源库", icon: "link", ready: false },
    ],
  },
  {
    key: "personal",
    items: [
      { key: "me", href: "/me", label: "我的", icon: "user-round", inTabBar: true, ready: true },
      {
        key: "admin",
        href: "/admin",
        label: "管理",
        icon: "shield",
        permission: "system.dashboard",
        ready: false,
      },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV.flatMap((section) => section.items);

/** Tab Bar 最多容得下 5 个，多了每个都太窄，点不准 */
export const TAB_BAR_MAX = 5;

export function tabBarItems(visible: (item: NavItem) => boolean): NavItem[] {
  return ALL_NAV_ITEMS.filter((item) => item.inTabBar && visible(item)).slice(0, TAB_BAR_MAX);
}

export function visibleSections(visible: (item: NavItem) => boolean): NavSection[] {
  return NAV.map((section) => ({
    ...section,
    items: section.items.filter(visible),
  })).filter((section) => section.items.length > 0);
}

/**
 * 当前激活的导航项。取匹配最长的那个 href ——
 * 否则 "/" 会匹配上所有路径，每个页面都显示成在首页。
 */
export function activeNavKey(pathname: string): string | null {
  let best: NavItem | null = null;
  for (const item of ALL_NAV_ITEMS) {
    const matches = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
    if (matches && (!best || item.href.length > best.href.length)) best = item;
  }
  return best?.key ?? null;
}
