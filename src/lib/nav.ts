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
  /** 需要登录才显示。访客看到自己用不了的入口只会点进去撞空状态 */
  requiresAuth?: boolean;
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
        // 全站总榜对所有人开放 —— 贡献排名是荣誉。
        // 分群榜单在页面内部按可见性收口，不靠隐藏入口来保护
        inTabBar: true,
        ready: true,
      },
      {
        key: "search",
        href: "/search",
        label: "检索",
        icon: "search",
        // 只有社群成员有可搜范围，访客搜出来必然为空
        permission: "group.messages.read",
        requiresAuth: true,
        inTabBar: true,
        ready: true,
      },
      {
        key: "forum",
        href: "/forum",
        label: "论坛",
        icon: "messages-square",
        // 公开版块对访客开放，具体帖子的可见性在查询层收口
        inTabBar: true,
        ready: true,
      },
    ],
  },
  {
    key: "community",
    label: "社区",
    items: [
      { key: "events", href: "/activities", label: "活动", icon: "calendar", ready: true },
      { key: "members", href: "/members", label: "成员", icon: "users", ready: false },
      { key: "links", href: "/links", label: "资源库", icon: "link", ready: false },
      { key: "shop", href: "/shop", label: "商店", icon: "gift", requiresAuth: true, ready: true },
    ],
  },
  {
    key: "personal",
    items: [
      {
        key: "notifications",
        href: "/notifications",
        label: "通知",
        icon: "bell",
        requiresAuth: true,
        ready: true,
      },
      {
        key: "me",
        href: "/me",
        label: "我的",
        icon: "user-round",
        requiresAuth: true,
        inTabBar: true,
        ready: true,
      },
      {
        key: "admin",
        href: "/admin",
        label: "管理",
        icon: "shield",
        permission: "system.dashboard",
        requiresAuth: true,
        ready: true,
      },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV.flatMap((section) => section.items);

export interface NavContext {
  loggedIn: boolean;
  /** 权限判定。服务端传 can()，测试可以传桩 */
  hasPermission: (permission: PermissionKey) => boolean;
}

/**
 * 导航项是否可见。**唯一实现** ——
 * AppShell 与测试都调这个，不各写一遍。
 * 同一段逻辑写两遍必然分叉，而分叉出来的那一份通常是漏了某个条件的。
 */
export function navItemVisible(item: NavItem, ctx: NavContext): boolean {
  if (!item.ready) return false;
  if (item.requiresAuth && !ctx.loggedIn) return false;
  if (!item.permission) return true;
  return ctx.hasPermission(item.permission);
}

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
