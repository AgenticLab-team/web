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
  /**
   * 这个板块「对访客开不开」是可配的，配置项由 `NavContext.guestOpen` 回答。
   *
   * 和 `requiresAuth` 的区别：那个是写死的，这个是管理员能改的。
   */
  guestOpenKey?: string;
  /**
   * 一级入口：桌面侧栏直接列出来，不收进「更多」。
   *
   * ─────────────────────────────────────────
   * 判据是「多久点一次」，不是「重不重要」
   * ─────────────────────────────────────────
   *
   * 后台设置很重要，榜单很好看，但没有人每天进去 ——
   * 而一级导航的成本是**它一直占着那一行**，让每天要点的那几个
   * 更难找。所以这里只放「每天都会点」的：首页、论坛、群聊、通知、我的。
   *
   * 其余的全部进「更多」，用减法算（见 sidebarMoreSections）——
   * 新页面默认收进去，不会因为有人忘了删而慢慢把侧栏堆满。
   */
  primary?: boolean;
  /** 出现在移动端底部 Tab Bar 里（最多 4 个，第 5 格留给「更多」） */
  inTabBar?: boolean;
  /**
   * 除 href 外，还有哪些路径前缀算「在这一项里」。
   *
   * 「群聊」是一个入口下面四个视图（回看、检索、链接、雷达），
   * 它们各自有独立的 URL。没有这一条的话，从回看点到检索，
   * 侧栏上那一项就灭了 —— 人会以为自己离开了这个板块。
   */
  alsoMatches?: string[];
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

/**
 * ─────────────────────────────────────────
 * 「群聊」是一个入口，不是四个
 * ─────────────────────────────────────────
 *
 * 按天回看、检索、资源库、关键词雷达，做的是同一件事的四个切面：
 * **把群里说过的话再找出来**。它们在数据上也确实是同一条流的衍生 ——
 * links / keyword_hits / message_windows 都是同步时从 messages 派生的。
 *
 * 之前这四个是：检索在一级、资源库和雷达在「社区」里、
 * 而按天回看**根本不在导航里** —— 它是站里数据最多的一页
 * （四万多条消息），却只能从搜索结果和通知里撞进去。
 *
 * 现在合成一个「群聊」，四个视图在页内用一排标签切换。
 * 落点是按天回看：它不受任何开关管，永远打得开。
 */
export const NAV: NavSection[] = [
  {
    key: "main",
    items: [
      { key: "home", href: "/", label: "首页", icon: "home", primary: true, inTabBar: true, ready: true },
      {
        key: "forum",
        flag: "forum",
        href: "/forum",
        label: "论坛",
        icon: "messages-square",
        // 公开版块对访客开放，具体帖子的可见性在查询层收口 ——
        // 但「对访客开不开」本身是可配的，关掉之后访客这里就不该有入口
        guestOpenKey: "forum",
        primary: true,
        inTabBar: true,
        ready: true,
      },
      {
        key: "chat",
        href: "/archive",
        label: "群聊",
        icon: "message-circle",
        // 只有社群成员有可看范围，访客进来只会撞一个空页面
        permission: "group.messages.read",
        requiresAuth: true,
        primary: true,
        inTabBar: true,
        // 检索 / 资源库 / 雷达 是同一个入口下的三个视图
        alsoMatches: ["/search", "/links", "/radar"],
        ready: true,
      },
      {
        key: "notifications",
        href: "/notifications",
        label: "通知",
        icon: "bell",
        requiresAuth: true,
        /*
         * 一级，但不占 tab 栏的格子。
         *
         * 手机上它在「更多」里，而「更多」会把里面所有条目的未读数
         * 加起来显示成一个红点（见 TabBar）—— 红点不会因为它被收进去而失联。
         * 桌面侧栏空间够，直接列出来，角标就在那一行上。
         */
        primary: true,
        ready: true,
      },
      {
        key: "me",
        href: "/me",
        label: "我的",
        icon: "user-round",
        requiresAuth: true,
        primary: true,
        inTabBar: true,
        ready: true,
      },
    ],
  },
  {
    key: "community",
    label: "社区",
    items: [
      { key: "members", href: "/members", label: "成员", icon: "users", requiresAuth: true, ready: true },
      {
        /*
         * 项目目录。要登录 —— 它把「站内某个人」和「某个 GitHub 账号」
         * 摆在同一行上，而那条对应关系是这个站拼出来的（见 auth/routes.ts）。
         *
         * ── 2026-08 改成一级 ────────────────────────
         *
         * 原来的判据是「一周也未必点一次」，那是按**它当时的样子**
         * 判的：一个只能看的目录。现在它是这个社区最适合对外展示的
         * 一张脸，而且加了自荐 —— 一个需要人主动走进去的地方，
         * 藏在「更多」里等于没有。
         *
         * 只动桌面（`primary`），**没进手机 tab 栏**：那里只有四个
         * 目的地且已经满了，挤掉首页/论坛/消息/通知里的任何一个
         * 都比多一个项目入口的代价大。手机上它仍在「更多」的第一屏。
         */
        primary: true,
        key: "projects",
        href: "/projects",
        label: "项目",
        /*
         * 图标名认不出来的话会**静默退回 Home** —— 侧栏上出现第二个
         * 小房子，没有任何地方报错。tests/nav.test.ts 那条守卫盯着
         * 「用了但表里没注册」的名字（它自己的正则原来漏了数字，
         * 所以 `folder-git-2` 一度被误报成没注册）。
         */
        icon: "folder-git-2",
        requiresAuth: true,
        ready: true,
      },
      {
        key: "leaderboard",
        href: "/leaderboard",
        label: "排行",
        icon: "trophy",
        // 全站总榜对所有人开放 —— 贡献排名是荣誉。
        // 分群榜单在页面内部按可见性收口，不靠隐藏入口来保护
        //
        // 不是一级：榜单是「偶尔看一眼」的东西，
        // 而一级的那几行要留给每天都点的。它在「更多」里。
        ready: true,
      },
      {
        key: "events",
        flag: "events",
        href: "/activities",
        label: "活动",
        icon: "calendar",
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
    label: "我的东西",
    items: [
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
        /*
         * 开放 API。
         *
         * 放在「我的东西」而不是单开一组：令牌是**他自己的**东西，
         * 和收藏夹、草稿箱同一类 —— 都是「只属于我的那几样」。
         *
         * 不是一级入口（不进 `primary`）：没有人每天建令牌。
         * 一级那几行要留给每天都点的，其余走「更多」，
         * 这是这份文件开头那条判据（「多久点一次」，不是「重不重要」）。
         */
        key: "api",
        href: "/me/api",
        label: "开放 API",
        icon: "key-round",
        requiresAuth: true,
        ready: true,
      },
    ],
  },
  {
    key: "system",
    label: "管理",
    items: [
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
  /**
   * 这个入口对**未登录访客**开不开。
   *
   * `requiresAuth` 是写死的「必须登录」，而有些板块是不是对外开放
   * 是**可配的** —— 论坛就是（`site.forum_public`）。
   * 配成关的时候，导航里还挂着一个点进去就弹登录的入口，
   * 不算泄露，但它把「这里没你的份」讲成了「网站坏了」。
   *
   * 和 featureEnabled 一样：不传就当开着。忘了传的后果是
   * 导航照常显示、页面那一侧仍然会拦，比反过来安全。
   */
  guestOpen?: (key: string) => boolean;
}

/**
 * 导航项是否可见。**唯一实现** ——
 * AppShell 与测试都调这个，不各写一遍。
 * 同一段逻辑写两遍必然分叉，而分叉出来的那一份通常是漏了某个条件的。
 */
export function navItemVisible(item: NavItem, ctx: NavContext): boolean {
  if (!item.ready) return false;
  if (item.requiresAuth && !ctx.loggedIn) return false;
  // 可配的对外开放：关掉之后，访客的导航里就不该再挂着它
  if (item.guestOpenKey && !ctx.loggedIn && ctx.guestOpen && !ctx.guestOpen(item.guestOpenKey)) {
    return false;
  }
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
 * 把 5 个塞进 tab 栏、剩下的只放在桌面侧栏里，结果是
 * **那些板块在手机上根本没有入口** —— 通知、资源库、活动、
 * 成员、雷达、商店，以及整个后台。
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
 * 桌面侧栏的一级区：只有 primary 的那几项，平铺、不分组。
 *
 * 分组标题在只有五行的时候是纯噪音 —— 五行不需要目录。
 */
export function sidebarPrimaryItems(visible: (item: NavItem) => boolean): NavItem[] {
  return ALL_NAV_ITEMS.filter((item) => item.primary && visible(item));
}

/**
 * 桌面侧栏的「更多」里放什么：**所有不是一级的**。
 *
 * 和手机端「更多」同一套减法。两边都不维护第二份清单，
 * 于是「桌面上摸得到、手机上摸不到」和它的反面都不可能发生 ——
 * 这两个函数各自覆盖全集，谁都不会漏掉新页面。
 */
export function sidebarMoreSections(visible: (item: NavItem) => boolean): NavSection[] {
  const primary = new Set(sidebarPrimaryItems(visible).map((i) => i.key));
  return NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => visible(item) && !primary.has(item.key)),
  })).filter((section) => section.items.length > 0);
}

/**
 * 当前激活的导航项。取匹配最长的那个 href ——
 * 否则 "/" 会匹配上所有路径，每个页面都显示成在首页。
 */
export function activeNavKey(pathname: string): string | null {
  let best: { item: NavItem; length: number } | null = null;

  for (const item of ALL_NAV_ITEMS) {
    for (const prefix of [item.href, ...(item.alsoMatches ?? [])]) {
      const matches = prefix === "/" ? pathname === "/" : pathname.startsWith(prefix);
      if (matches && (!best || prefix.length > best.length)) {
        best = { item, length: prefix.length };
      }
    }
  }

  return best?.item.key ?? null;
}
