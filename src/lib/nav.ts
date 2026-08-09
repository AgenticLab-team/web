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
  /**
   * 受哪个功能开关管。
   *
   * 关掉之后这一项从导航里消失 —— 而**页面本身也要 404**
   * （见 lib/flags/server.ts 的 requireFeature）：
   * 只藏导航的话，地址栏敲一下照样进得去，那不是开关，是把门牌摘了。
   */
  flag?: string;
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
        //
        // 不占 tab 栏的格子：榜单是「偶尔看一眼」的东西，
        // 而 tab 栏的 5 个格子要留给每天都点的。它在「更多」里。
        ready: true,
      },
      {
        key: "search",
        flag: "message_search",
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
        flag: "forum",
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
      {
        key: "events",
        flag: "events",
        href: "/activities",
        label: "活动",
        icon: "calendar",
        ready: true,
      },
      { key: "members", href: "/members", label: "成员", icon: "users", requiresAuth: true, ready: true },
      {
        key: "links",
        flag: "link_library",
        href: "/links",
        label: "资源库",
        icon: "link",
        requiresAuth: true,
        ready: true,
      },
      {
        key: "radar",
        flag: "keyword_radar",
        href: "/radar",
        label: "关键词雷达",
        icon: "radar",
        requiresAuth: true,
        ready: true,
      },
      {
        key: "shop",
        flag: "shop",
        href: "/shop",
        label: "商店",
        icon: "gift",
        requiresAuth: true,
        ready: true,
      },
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
        key: "bookmarks",
        href: "/me/bookmarks",
        label: "收藏夹",
        icon: "bookmark",
        requiresAuth: true,
        ready: true,
      },
      {
        key: "drafts",
        href: "/me/drafts",
        label: "草稿箱",
        icon: "file-text",
        requiresAuth: true,
        ready: true,
      },
      {
        key: "following",
        href: "/me/following",
        label: "我关注的",
        icon: "user-plus",
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
  /**
   * 功能开关。传桩即可 —— 这一层不碰数据库。
   *
   * 不传就当全开：测试和早期调用点不必为了一个开关去建整套上下文，
   * 而「忘了传」的后果是导航照常显示（页面那一侧仍然会 404），
   * 比反过来安全 —— 反过来是一次疏忽让整个导航空掉。
   */
  featureEnabled?: (flag: string) => boolean;
}

/**
 * 导航项是否可见。**唯一实现** ——
 * AppShell 与测试都调这个，不各写一遍。
 * 同一段逻辑写两遍必然分叉，而分叉出来的那一份通常是漏了某个条件的。
 */
export function navItemVisible(item: NavItem, ctx: NavContext): boolean {
  if (!item.ready) return false;
  if (item.requiresAuth && !ctx.loggedIn) return false;
  // 功能关掉了就不出现在导航里 —— 页面那一侧还会再挡一次
  if (item.flag && ctx.featureEnabled && !ctx.featureEnabled(item.flag)) return false;
  if (!item.permission) return true;
  return ctx.hasPermission(item.permission);
}

/**
 * Tab Bar 最多容得下 5 个，多了每个都太窄，点不准。
 *
 * ─────────────────────────────────────────
 * 第 5 格永远是「更多」，不是第 5 个目的地
 * ─────────────────────────────────────────
 *
 * 这个站有 12 个前台入口。把 5 个塞进 tab 栏、剩下 7 个只放在
 * 桌面侧栏里，结果是**手机上那 7 个板块根本没有入口** ——
 * 通知、资源库、活动、成员、雷达、商店，以及整个后台。
 *
 * 那不是「手机端功能少一点」，是这些功能在手机上不存在，
 * 而这个站大部分人是在微信里点开的。
 *
 * 所以 tab 栏只放 4 个真正天天点的，第 5 格固定是「更多」，
 * 「更多」里放**全部**剩下的 —— 任何新页面都自动够得着，
 * 不需要有人记得去改 tab 栏。
 */
export const TAB_BAR_MAX = 5;

/** 留给「更多」，所以真正的目的地只有 4 个 */
export const TAB_BAR_DESTINATIONS = TAB_BAR_MAX - 1;

export function tabBarItems(visible: (item: NavItem) => boolean): NavItem[] {
  return ALL_NAV_ITEMS.filter((item) => item.inTabBar && visible(item)).slice(
    0,
    TAB_BAR_DESTINATIONS,
  );
}

/**
 * 「更多」里放什么：**所有不在 tab 栏里的**。
 *
 * 刻意用「减法」而不是维护第二份清单 ——
 * 维护两份清单的话，加了新页面而忘了往「更多」里加，
 * 表现就是手机上摸不到它，而桌面上一切正常，很难被发现。
 */
export function moreSheetSections(visible: (item: NavItem) => boolean): NavSection[] {
  const inTabs = new Set(tabBarItems(visible).map((i) => i.key));
  return NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => visible(item) && !inTabs.has(item.key)),
  })).filter((section) => section.items.length > 0);
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
