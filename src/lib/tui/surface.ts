import type { ScopeKey } from "@/lib/api-tokens/rules";

/**
 * 站里每一个「面」的唯一真源 —— 网页在哪、终端在哪、靠哪些端点连起来。
 *
 * ═════════════════════════════════════════
 * 这张表要解决的是一个**时间上**的问题
 * ═════════════════════════════════════════
 *
 * 「终端里有网页上的每一样东西」这句话，在第一版交付那天是真的。
 * 难的是三个月后 —— 网页加了两个页面、改了一条规则，
 * 而终端那边没有人记得跟。
 *
 * 它退化的样子很难被发现：终端仍然能跑、能看群聊、能发帖，
 * 只是**新加的那两个板块在终端里根本不存在**。
 * 而「不存在」不会报错，也不会有人抱怨 —— 用终端的人
 * 压根不知道网页上多了什么。
 *
 * 这和 `ARCHITECTURE.md` 第二节讲的死开关是同一种病：
 * **缺的功能人看得出来，一个没人想过的缺口不会有任何症状。**
 *
 * 所以有了这张表和 `tests/tui-parity.test.ts`：
 * 网页上加一个页面，这张表里必须多一行，
 * 而那一行强迫加页面的人当场回答「终端里怎么办」。
 *
 * ─────────────────────────────────────────
 * 它**不是**一份文档
 * ─────────────────────────────────────────
 *
 * 文档会过期而没有症状，这张表过期就是红的。
 * 所以这里只写机器能核对的字段（路由、端点、屏幕 id、scope），
 * 讲「为什么」的话去 `TUI.md`。
 */

/** 终端最左边那一竖里的分区。顺序就是显示顺序 */
export type Board = "chat" | "forum" | "community" | "me" | "admin";

export interface Surface {
  /** 稳定标识，审计和遥测里用它。改名等于换一个面 */
  key: string;
  label: string;
  board: Board;
  /**
   * 网页上的路由，写 App Router 的字面路径（含 `[param]`）。
   * `null` = 这个面在网页上没有独立页面（例如只存在于终端的命令面板）。
   */
  web: string | null;
  /**
   * 终端里的屏幕 id，对应 `tui/internal/ui/screens` 里注册的那个。
   *
   * **`null` 必须同时写 `why`** —— 一个没有理由的缺口，
   * 六个月后没有人敢补，因为不知道当初为什么不做。
   */
  tui: string | null;
  /** `tui` 为 null 时必填：为什么终端里没有这个 */
  why?: string;
  /**
   * 终端靠哪些端点做到同一件事。写成 `"GET /api/v1/..."`。
   *
   * 这一栏是**可核对的**：`tests/tui-parity.test.ts` 会对着
   * `lib/api-tokens/catalog.ts` 查，写了不存在的端点就红。
   * 它防的是「终端屏幕做出来了，但它调的接口其实没上线」。
   */
  api: string[];
  /**
   * **打开这一屏**至少要哪些 scope。缺了就根本进不去，
   * 终端在进去之前就说清楚缺哪一项，而不是让人看一屏错误。
   */
  scopes: ScopeKey[];
  /**
   * 屏里**某些动作**才要的 scope。缺了这一屏照常打开，只是那个动作不可用。
   *
   * ═════════════════════════════════════════
   * 为什么必须和 `scopes` 分开
   * ═════════════════════════════════════════
   *
   * 群聊那一屏是最典型的：读消息要 `groups:read`，发消息要 `groups:send`，
   * 而**绝大多数人没有 `groups:send`**（它默认不给，且要站长逐群授权）。
   *
   * 两者合并成一条的话只有两种结果，都是错的：
   *   · 合进 `scopes` → 没有发送权限的人**连群聊都打不开**
   *   · 干脆不声明 → 输入框长得能打字，敲完回车拿一句 403，
   *     而人会以为是自己哪里写错了
   *
   * 分开之后，终端拿到的是第三种：屏正常打开，输入框位置显示一行
   * 「这个群没有开代发，要开的话找站长说一声」—— 在他动手之前。
   *
   * `tests/tui-parity.test.ts` 要求每个写端点的 scope 出现在
   * `scopes` 或这里，二者必居其一 —— 也就是说**不许有没想过的写操作**。
   */
  optionalScopes?: ScopeKey[];
  /**
   * 后台专用：这个面对应 `lib/admin/api-registry.ts` 里的哪个分区。
   *
   * 三十个后台页共用同一对端点（`GET`/`POST /api/v1/admin/{section}`），
   * 靠这个值区分。填了它的面，`tests/tui-parity.test.ts` 会额外核对
   * 注册表里真的有这个分区 —— 否则终端里那一屏点进去是空的，
   * 而表面上「对齐得很好」。
   */
  adminSection?: string;
}

/**
 * ─────────────────────────────────────────
 * 排序即导航
 * ─────────────────────────────────────────
 *
 * 终端最左那一竖按 `board` 分组、组内按这里的顺序排。
 * 也就是说改这张表的顺序会改动界面 —— 这是故意的：
 * 导航顺序是产品决定，不该散落在 Go 那侧的某个数组里。
 */
export const SURFACES: readonly Surface[] = [
  /* ── 群聊 ─────────────────────────────────────────── */
  {
    key: "chat.archive",
    label: "按天回看",
    board: "chat",
    web: "/archive",
    tui: "chat/archive",
    api: ["GET /api/v1/groups", "GET /api/v1/archive", "GET /api/v1/groups/{conv_id}/messages"],
    scopes: ["groups:read"],
  },
  {
    key: "chat.live",
    label: "群聊",
    board: "chat",
    /*
     * 终端独有：网页上没有一个「像聊天软件一样的群聊窗口」——
     * 网页那边是按天回看 + 检索两个入口。终端里把它们合成一个
     * 常驻窗口更自然，因为终端本来就是个常驻窗口。
     *
     * 这不违反「网页有的终端都有」：那条说的是不许少，没说不许多。
     */
    web: null,
    tui: "chat/live",
    api: [
      "GET /api/v1/groups",
      "GET /api/v1/groups/{conv_id}/messages",
      "POST /api/v1/groups/{conv_id}/messages",
      "GET /api/v1/groups/{conv_id}/members",
    ],
    scopes: ["groups:read"],
    /* 没有代发授权也照常进群聊 —— 只是输入框那一行换成一句解释，见 TUI.md 第六节 */
    optionalScopes: ["groups:send"],
  },
  {
    key: "chat.search",
    label: "检索",
    board: "chat",
    web: "/search",
    tui: "chat/search",
    api: ["GET /api/v1/search"],
    scopes: ["groups:read"],
  },
  {
    key: "chat.links",
    label: "资源库",
    board: "chat",
    web: "/links",
    tui: "chat/links",
    api: ["GET /api/v1/links", "POST /api/v1/links/{id}/vote", "POST /api/v1/links/{id}/save"],
    scopes: ["groups:read"],
    /* 投票和收藏是「顺手」的动作；没有它照样能看资源库 */
    optionalScopes: ["me:write"],
  },
  {
    key: "chat.radar",
    label: "关键词雷达",
    board: "chat",
    web: "/radar",
    tui: "chat/radar",
    api: ["GET /api/v1/radar", "POST /api/v1/radar", "DELETE /api/v1/radar/{id}"],
    scopes: ["groups:read"],
    /* 读雷达命中要 groups:read，增删关键词才要 me:write */
    optionalScopes: ["me:write"],
  },
  {
    key: "chat.stats",
    label: "群统计",
    board: "chat",
    web: null,
    tui: "chat/stats",
    api: ["GET /api/v1/groups/{conv_id}/stats"],
    scopes: ["groups:read"],
  },
  {
    key: "chat.announcement",
    label: "群公告",
    board: "chat",
    web: null,
    tui: "chat/announcement",
    api: [
      "GET /api/v1/groups/{conv_id}/announcement",
      "POST /api/v1/groups/{conv_id}/announcement",
    ],
    scopes: ["groups:read"],
    /* 群里每个人都读得到公告，改公告才要代发授权 */
    optionalScopes: ["groups:send"],
  },

  /* ── 论坛 ─────────────────────────────────────────── */
  {
    key: "forum.index",
    label: "论坛",
    board: "forum",
    web: "/forum",
    tui: "forum/index",
    api: ["GET /api/v1/forum/boards", "GET /api/v1/posts"],
    scopes: ["forum:read"],
  },
  {
    key: "forum.board",
    label: "版块",
    board: "forum",
    web: "/forum/[board]",
    tui: "forum/board",
    api: ["GET /api/v1/posts"],
    scopes: ["forum:read"],
  },
  {
    key: "forum.post",
    label: "帖子正文",
    board: "forum",
    web: "/forum/p/[id]",
    tui: "forum/post",
    api: [
      "GET /api/v1/posts/{id}",
      "POST /api/v1/posts/{id}/replies",
      "POST /api/v1/posts/{id}/react",
      "POST /api/v1/posts/{id}/vote",
      "POST /api/v1/posts/{id}/accept",
      "POST /api/v1/posts/{id}/report",
      "POST /api/v1/posts/{id}/tip",
      "POST /api/v1/posts/{id}/bookmark",
    ],
    scopes: ["forum:read"],
    /* 正文永远读得到；回复/表情/投票/采纳/举报要 forum:write，打赏花积分，收藏是 me:write */
    optionalScopes: ["forum:write", "economy:write", "me:write"],
  },
  {
    key: "forum.new",
    label: "发帖",
    board: "forum",
    web: "/forum/new",
    tui: "forum/new",
    api: ["GET /api/v1/forum/boards", "POST /api/v1/posts", "POST /api/v1/me/drafts"],
    scopes: ["forum:write"],
    /* 存草稿归「我的东西」，和发帖不是同一个 scope */
    optionalScopes: ["me:write"],
  },
  {
    key: "forum.edit",
    label: "编辑帖子",
    board: "forum",
    web: "/forum/p/[id]/edit",
    tui: "forum/edit",
    api: ["GET /api/v1/posts/{id}", "PATCH /api/v1/posts/{id}"],
    scopes: ["forum:write"],
  },
  {
    key: "forum.history",
    label: "编辑历史",
    board: "forum",
    web: "/forum/p/[id]/history",
    tui: "forum/history",
    api: ["GET /api/v1/posts/{id}/history"],
    scopes: ["forum:read"],
  },
  {
    key: "forum.search",
    label: "论坛搜索",
    board: "forum",
    web: "/forum/search",
    tui: "forum/search",
    api: ["GET /api/v1/forum/search"],
    scopes: ["forum:read"],
  },
  {
    key: "forum.deep",
    label: "深潜",
    board: "forum",
    web: "/forum/deep",
    tui: "forum/deep",
    api: ["GET /api/v1/forum/deep"],
    scopes: ["forum:read"],
  },
  {
    key: "forum.convert",
    label: "群消息转帖",
    board: "forum",
    web: "/forum/convert",
    tui: "forum/convert",
    api: ["GET /api/v1/groups/{conv_id}/messages", "POST /api/v1/forum/convert"],
    scopes: ["forum:write", "groups:read"],
  },

  /* ── 社区 ─────────────────────────────────────────── */
  {
    key: "community.home",
    label: "首页",
    board: "community",
    web: "/",
    tui: "community/home",
    api: ["GET /api/v1/home"],
    scopes: [],
  },
  {
    key: "community.members",
    label: "成员",
    board: "community",
    web: "/members",
    tui: "community/members",
    api: ["GET /api/v1/members"],
    scopes: ["community:read"],
  },
  {
    key: "community.person",
    label: "成员主页",
    board: "community",
    web: "/members/[wxId]",
    tui: "community/person",
    api: ["GET /api/v1/members/{wx_id}", "POST /api/v1/me/following"],
    scopes: ["community:read"],
    /* 关注按钮才要 me:write；主页本身只要 community:read */
    optionalScopes: ["me:write"],
  },
  {
    key: "community.person-by-id",
    label: "按账号 id 找人",
    board: "community",
    web: "/members/by/[userId]",
    /*
     * 网页上这一页只做一件事：把 user_id 换成 wx_id 然后 302。
     * 终端里没有地址栏，也就没有「拿着一个 id 不知道去哪」这个问题 ——
     * 跳转在客户端内部就完成了，不需要一个屏幕。
     */
    tui: null,
    why: "网页上它只是一个 302 跳板；终端里跳转在客户端内部完成，没有对应物",
    api: ["GET /api/v1/members/{wx_id}"],
    scopes: ["community:read"],
  },
  {
    key: "community.leaderboard",
    label: "排行榜",
    board: "community",
    web: "/leaderboard",
    tui: "community/leaderboard",
    api: ["GET /api/v1/leaderboard"],
    scopes: [],
  },
  {
    key: "community.projects",
    label: "项目目录",
    board: "community",
    web: "/projects",
    tui: "community/projects",
    api: ["GET /api/v1/projects", "POST /api/v1/projects"],
    scopes: ["community:read"],
    /* 自荐才要 me:write */
    optionalScopes: ["me:write"],
  },
  {
    key: "community.repo",
    label: "项目详情",
    board: "community",
    web: "/projects/[owner]/[repo]",
    tui: "community/repo",
    api: ["GET /api/v1/projects/{owner}/{repo}"],
    scopes: ["community:read"],
  },
  {
    key: "community.activities",
    label: "活动",
    board: "community",
    web: "/activities",
    tui: "community/activities",
    api: [
      "GET /api/v1/activities",
      "GET /api/v1/activities/{id}",
      "POST /api/v1/activities/{id}/apply",
    ],
    scopes: ["community:read"],
    /* 看得到活动 ≠ 报得上名：报名有独立 scope，也有名额和资格判定 */
    optionalScopes: ["activities:write"],
  },
  {
    key: "community.activity",
    label: "活动详情",
    board: "community",
    /*
     * 网页上活动详情和列表在同一页（每个活动是一张卡，资格条摊在卡里）。
     * 终端里分成两屏：一屏放不下十个活动各自的资格明细，
     * 而资格明细恰恰是这一块最有用的东西 —— 它逐条说「你差在哪」。
     */
    web: null,
    tui: "community/activity",
    api: ["GET /api/v1/activities/{id}", "POST /api/v1/activities/{id}/apply"],
    scopes: ["community:read"],
    optionalScopes: ["activities:write"],
  },
  {
    key: "community.shop",
    label: "商店",
    board: "community",
    web: "/shop",
    tui: "community/shop",
    api: ["GET /api/v1/shop", "POST /api/v1/shop/{id}/buy"],
    scopes: ["community:read"],
    /* 橱窗人人可看，下单才扣积分 */
    optionalScopes: ["economy:write"],
  },
  {
    key: "community.welcome",
    label: "新人引导",
    board: "community",
    web: "/welcome",
    tui: "community/welcome",
    api: ["GET /api/v1/welcome"],
    scopes: ["me:read"],
  },
  {
    key: "community.onboarding",
    label: "入站设置",
    board: "community",
    web: "/onboarding",
    tui: "community/onboarding",
    api: ["GET /api/v1/welcome", "POST /api/v1/me/profile"],
    scopes: ["me:write"],
  },
  {
    key: "community.join",
    label: "申请加入",
    board: "community",
    web: "/join",
    /*
     * 这一页是给**还没有账号的人**看的：填一份申请，等站长审。
     * 而终端客户端的第一步就是登录 —— 没有账号的人连不进来。
     *
     * 做一个「在终端里申请加入」的屏幕等于在微信群那扇门旁边
     * 开第二个入口，而那正是 `ARCHITECTURE.md` 第五节里
     * 「任何『用 X 就能注册进来』的路径」那一条禁的东西。
     */
    tui: null,
    why: "给没有账号的人用的，而终端的第一步就是登录 —— 在这里开入口等于绕开「只有群成员能登录」",
    api: [],
    scopes: [],
  },
  {
    key: "community.login",
    label: "登录",
    board: "community",
    web: "/login",
    tui: null,
    why: "终端登录走设备码（见 TUI.md 第四节）；密码和 passkey 都要浏览器，终端里没有认证器",
    api: ["POST /api/v1/auth/device/start", "POST /api/v1/auth/device/poll"],
    scopes: [],
  },
  {
    key: "community.device-link",
    label: "确认终端登录",
    board: "community",
    web: "/link",
    /*
     * 这一页**按定义**在终端里没有对应物：它是设备码流程的
     * 「另一半」—— 在一个已经登录的浏览器里，确认某台终端可以
     * 以你的身份行事。
     *
     * 如果终端里也能确认，那这套流程就退化成了「终端自己批准自己」，
     * 中间那道人的判断整个消失了 —— 而那道判断是它唯一的安全边界。
     */
    tui: null,
    why: "设备码流程的浏览器那一半：终端里也能确认的话，就成了终端自己批准自己，中间那道人的判断整个消失",
    api: [],
    scopes: [],
  },

  /* ── 我的 ─────────────────────────────────────────── */
  {
    key: "me.home",
    label: "我的",
    board: "me",
    web: "/me",
    tui: "me/home",
    api: ["GET /api/v1/me"],
    scopes: ["me:read"],
  },
  {
    key: "me.profile",
    label: "编辑资料",
    board: "me",
    web: "/me/profile",
    tui: "me/profile",
    api: ["GET /api/v1/me", "POST /api/v1/me/profile"],
    scopes: ["me:write"],
  },
  {
    key: "me.points",
    label: "积分与打卡",
    board: "me",
    web: "/me/points",
    tui: "me/points",
    api: ["GET /api/v1/me/points", "POST /api/v1/me/checkin", "POST /api/v1/me/makeup"],
    scopes: ["me:read"],
    /* 打卡要 me:write，补签卡花积分 */
    optionalScopes: ["me:write", "economy:write"],
  },
  {
    key: "me.titles",
    label: "称号",
    board: "me",
    web: null,
    tui: "me/titles",
    api: ["GET /api/v1/me/titles", "POST /api/v1/me/titles/equip"],
    scopes: ["me:read"],
    optionalScopes: ["me:write"],
  },
  {
    key: "me.bookmarks",
    label: "收藏夹",
    board: "me",
    web: "/me/bookmarks",
    tui: "me/bookmarks",
    api: ["GET /api/v1/me/bookmarks", "POST /api/v1/posts/{id}/bookmark"],
    scopes: ["me:read"],
    optionalScopes: ["me:write"],
  },
  {
    key: "me.drafts",
    label: "草稿箱",
    board: "me",
    web: "/me/drafts",
    tui: "me/drafts",
    api: ["GET /api/v1/me/drafts", "POST /api/v1/me/drafts", "DELETE /api/v1/me/drafts/{id}"],
    scopes: ["me:read"],
    optionalScopes: ["me:write"],
  },
  {
    key: "me.following",
    label: "关注",
    board: "me",
    web: "/me/following",
    tui: "me/following",
    api: ["GET /api/v1/me/following", "POST /api/v1/me/following"],
    scopes: ["me:read"],
    optionalScopes: ["me:write"],
  },
  {
    key: "me.notifications",
    label: "通知",
    board: "me",
    web: "/notifications",
    tui: "me/notifications",
    api: [
      "GET /api/v1/me/notifications",
      "POST /api/v1/me/notifications/read",
      "GET /api/v1/me/notifications/stream",
    ],
    scopes: ["notifications:read"],
    /* 读通知和标已读是两个 scope：后者读不到内容 */
    optionalScopes: ["notifications:write"],
  },
  {
    key: "me.notification-prefs",
    label: "通知设置",
    board: "me",
    web: "/me/notifications",
    tui: "me/notification-prefs",
    api: ["GET /api/v1/me/notifications/prefs", "POST /api/v1/me/notifications/prefs"],
    scopes: ["notifications:write"],
  },
  {
    key: "me.privacy",
    label: "隐私",
    board: "me",
    web: "/me/privacy",
    tui: "me/privacy",
    api: ["GET /api/v1/me/privacy", "POST /api/v1/me/privacy"],
    scopes: ["me:read"],
    optionalScopes: ["me:write"],
  },
  {
    key: "me.moderation",
    label: "我的处罚与申诉",
    board: "me",
    web: "/me/moderation",
    tui: "me/moderation",
    api: ["GET /api/v1/me/moderation", "POST /api/v1/me/appeals"],
    scopes: ["me:read"],
    /* 看得到处罚，提申诉才要写权限 */
    optionalScopes: ["me:write"],
  },
  {
    key: "me.tokens",
    label: "开放 API",
    board: "me",
    web: "/me/api",
    tui: "me/tokens",
    api: [
      "GET /api/v1/me/tokens",
      "POST /api/v1/me/tokens",
      "DELETE /api/v1/me/tokens/{id}",
      "GET /api/v1/docs",
    ],
    scopes: ["me:read"],
    /* 列令牌是读；建和撤销是写 —— 一把只读令牌不该能撤销别的令牌 */
    optionalScopes: ["me:write"],
  },
  {
    key: "me.security",
    label: "登录与设备",
    board: "me",
    web: "/me/security",
    /*
     * 会话列表、踢下线、以及**看得见自己有哪些终端令牌**，
     * 这些终端里都做得到。做不到的只有 passkey 的注册与验证 ——
     * 那要一个浏览器里的认证器，终端里没有对应物。
     * 所以这一屏在遇到 passkey 时给的是一句话加一个网址，
     * 而不是假装有一个按钮。
     */
    tui: "me/security",
    api: ["GET /api/v1/me/sessions", "DELETE /api/v1/me/sessions/{id}"],
    scopes: ["me:read"],
    optionalScopes: ["me:write"],
  },
  {
    key: "me.export",
    label: "导出我的数据",
    board: "me",
    web: "/me/export",
    tui: "me/export",
    api: ["POST /api/v1/me/export", "GET /api/v1/me/export"],
    scopes: ["me:read"],
  },
  {
    key: "me.update",
    label: "版本与自更新",
    board: "me",
    /*
     * 网页上没有对应物 —— 网页不需要「检查更新」，刷新一下就是最新的。
     * 这一屏是终端独有的，因为终端里跑的是一个会过期的二进制。
     */
    web: null,
    tui: "me/update",
    api: ["GET /api/v1/release"],
    scopes: [],
  },
  {
    key: "me.shortlink",
    label: "分享短链",
    board: "me",
    web: null,
    tui: null,
    why: "网页上 /p/[code] 是一条 302 路由不是页面；终端里分享给出的是完整链接，没有中转",
    api: [],
    scopes: [],
  },

  /* ── 管理 ─────────────────────────────────────────── */
  /*
   * ═════════════════════════════════════════
   * 后台三十个页面，只有三条端点
   * ═════════════════════════════════════════
   *
   * 一页一条端点的话是五十多条：三十个读、二十多个写。
   * 那意味着加一个后台页要在**三个地方**各写一遍
   * （页面、路由文件、这张表），而三处里迟早有一处会被忘掉。
   *
   * 现在它们共用 `GET /api/v1/admin/{section}` 和
   * `POST /api/v1/admin/{section}`，`section` 就是下面每一条的
   * `adminSection`。真正的分工写在 `lib/admin/api-registry.ts`：
   * 那张注册表声明每个分区要哪个权限点、读什么、能做哪些动作。
   *
   * 好处不只是少写代码 —— 注册表和 `lib/admin/nav.ts` 之间
   * 有一条守卫（`tests/tui-parity.test.ts`）：后台导航里多一项
   * 而注册表里没有，就是红的。
   */
  {
    key: "admin.dashboard",
    label: "后台首页",
    board: "admin",
    web: "/admin",
    tui: "admin/dashboard",
    adminSection: "dashboard",
    /*
     * 分区清单挂在首页这一条上。
     *
     * 它是**按人算过的**：终端最左那一竖里后台底下列哪几项，
     * 靠的就是这条接口，而不是把三十个分区写死在 Go 那边。
     * 写死的话，一个只有审计权限的人会看到一整排点进去是 403 的入口。
     */
    api: [
      "GET /api/v1/admin/sections",
      "GET /api/v1/admin/{section}",
      "POST /api/v1/admin/{section}",
    ],
    scopes: ["admin:all"],
  },
  {
    key: "admin.users",
    label: "用户",
    board: "admin",
    web: "/admin/users",
    tui: "admin/users",
    adminSection: "users",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.user",
    label: "用户详情",
    board: "admin",
    web: "/admin/users/[id]",
    tui: "admin/user",
    adminSection: "user",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.posts",
    label: "帖子管理",
    board: "admin",
    web: "/admin/posts",
    tui: "admin/posts",
    adminSection: "posts",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.reports",
    label: "举报",
    board: "admin",
    web: "/admin/reports",
    tui: "admin/reports",
    adminSection: "reports",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.appeals",
    label: "申诉",
    board: "admin",
    web: "/admin/appeals",
    tui: "admin/appeals",
    adminSection: "appeals",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.approvals",
    label: "审批队列",
    board: "admin",
    web: "/admin/approvals",
    tui: "admin/approvals",
    adminSection: "approvals",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.escalation",
    label: "升级处置",
    board: "admin",
    web: "/admin/escalation",
    tui: "admin/escalation",
    adminSection: "escalation",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.audit",
    label: "审计日志",
    board: "admin",
    web: "/admin/audit",
    tui: "admin/audit",
    adminSection: "audit",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.boards",
    label: "版块",
    board: "admin",
    web: "/admin/boards",
    tui: "admin/boards",
    adminSection: "boards",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.words",
    label: "敏感词",
    board: "admin",
    web: "/admin/words",
    tui: "admin/words",
    adminSection: "words",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.groups",
    label: "群与同步",
    board: "admin",
    web: "/admin/groups",
    tui: "admin/groups",
    adminSection: "groups",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.binds",
    label: "绑定队列",
    board: "admin",
    web: "/admin/binds",
    tui: "admin/binds",
    adminSection: "binds",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.invites",
    label: "邀请码",
    board: "admin",
    web: "/admin/invites",
    tui: "admin/invites",
    adminSection: "invites",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.roles",
    label: "身份组与权限矩阵",
    board: "admin",
    web: "/admin/roles",
    tui: "admin/roles",
    adminSection: "roles",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.settings",
    label: "系统设置",
    board: "admin",
    web: "/admin/settings",
    tui: "admin/settings",
    adminSection: "settings",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.flags",
    label: "功能开关",
    board: "admin",
    web: "/admin/flags",
    tui: "admin/flags",
    adminSection: "flags",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.modules",
    label: "模块",
    board: "admin",
    web: "/admin/modules",
    tui: "admin/modules",
    adminSection: "modules",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.points",
    label: "积分总览",
    board: "admin",
    web: "/admin/points",
    tui: "admin/points",
    adminSection: "points",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.points-ledger",
    label: "积分流水",
    board: "admin",
    web: "/admin/points/ledger",
    tui: "admin/points-ledger",
    adminSection: "points-ledger",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.points-levels",
    label: "等级",
    board: "admin",
    web: "/admin/points/levels",
    tui: "admin/points-levels",
    adminSection: "points-levels",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.shop",
    label: "商店管理",
    board: "admin",
    web: "/admin/shop",
    tui: "admin/shop",
    adminSection: "shop",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.activities",
    label: "活动管理",
    board: "admin",
    web: "/admin/activities",
    tui: "admin/activities",
    adminSection: "activities",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.broadcast",
    label: "群发",
    board: "admin",
    web: "/admin/broadcast",
    tui: "admin/broadcast",
    adminSection: "broadcast",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all", "groups:send"],
  },
  {
    key: "admin.community",
    label: "社区健康",
    board: "admin",
    web: "/admin/community",
    tui: "admin/community",
    adminSection: "community",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.health",
    label: "健康检查",
    board: "admin",
    web: "/admin/health",
    tui: "admin/health",
    adminSection: "health",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.storage",
    label: "存储",
    board: "admin",
    web: "/admin/storage",
    tui: "admin/storage",
    adminSection: "storage",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.backup",
    label: "备份",
    board: "admin",
    web: "/admin/backup",
    tui: "admin/backup",
    adminSection: "backup",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.llm",
    label: "LLM",
    board: "admin",
    web: "/admin/llm",
    tui: "admin/llm",
    adminSection: "llm",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.api",
    label: "开放 API 管理",
    board: "admin",
    web: "/admin/api",
    tui: "admin/api",
    adminSection: "api",
    api: ["GET /api/v1/admin/{section}", "POST /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.mail",
    label: "邮箱与域名池",
    board: "admin",
    web: "/admin/mail",
    tui: "admin/mail",
    adminSection: "mail",
    api: ["GET /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },
  {
    key: "admin.oauth",
    label: "OAuth 应用",
    board: "admin",
    web: "/admin/oauth",
    tui: "admin/oauth",
    adminSection: "oauth",
    api: ["GET /api/v1/admin/{section}"],
    scopes: ["admin:all"],
  },

  /* ── 两个功能分支合进来时补的 ─────────────────────── */
  {
    key: "me.mail",
    label: "一次性邮箱",
    board: "me",
    web: "/mail/burner",
    tui: "me/mail",
    api: ["GET /api/v1/mail/burners", "POST /api/v1/mail/burners", "DELETE /api/v1/mail/burners/{id}"],
    scopes: ["mail:burner"],
  },
  {
    key: "me.mail.box",
    label: "这个箱子收到的信",
    board: "me",
    /*
     * ═════════════════════════════════════════
     * 网页上没有单独一页，所以是 `null`
     * ═════════════════════════════════════════
     *
     * 网页那一页能同时铺开「我有哪几个箱子」和「这个箱子收到的信」；
     * 终端里那是两种翻页节奏 —— 前者是一张短表，后者要一直往下读。
     * 挤进一屏的话信的正文只剩四五行，而人来这儿就是为了读那封信。
     *
     * 一个网页页面对两个终端屏，是这张表允许的：`web` 那一栏
     * 回答的是「网页上有没有独立的一页」，不是「有没有对应物」。
     */
    web: null,
    tui: "me/mail/box",
    api: ["GET /api/v1/mail/burners/{id}", "GET /api/v1/mail/burners/{id}/messages"],
    scopes: ["mail:burner"],
  },
  {
    key: "oauth.consent",
    label: "授权确认",
    board: "me",
    web: "/oauth/authorize",
    /*
     * 和设备码那个批准页同一条理由，而且更硬：
     * 同意页是这整套流程**唯一**的安全边界 —— 它要人看着那几项权限
     * 按下去。终端里也能按的话，就成了程序自己批准自己。
     */
    tui: null,
    why: "同意页是 OAuth 唯一的那道人的判断：终端里也能按的话，就成了程序自己批准自己",
    api: [],
    scopes: [],
  },
];

/*
 * ─────────────────────────────────────────
 * 「按 key 取」和「某个分区下有哪几屏」**不在这一侧**
 * ─────────────────────────────────────────
 *
 * 那两件事只有终端要做，而终端是 Go 写的：它读的是
 * `tui/internal/surface/surface.gen.json`（由这张表生成，
 * `npm run tui:gen`，有测试盯着两边不脱节）。
 *
 * 在 TS 这侧也留一份的话，它没有任何调用方 —— 而一个
 * 没有调用方的导出读起来像有人在守着，实际什么都没守。
 */

/**
 * 网页路由 → 面。
 *
 * 用来把网页链接翻译成终端里的跳转 —— 帖子正文里贴着一条
 * `https://agenticlab.sh/members/xxx`，终端里按回车应该进成员主页，
 * 而不是弹出一个浏览器。
 *
 * 匹配时把 `[param]` 当通配符，返回**最长的那条**：
 * `/forum/p/[id]/edit` 和 `/forum/p/[id]` 都能匹配前者的路径，
 * 取短的会把「编辑」认成「正文」。
 */
export function surfaceForWebPath(path: string): Surface | null {
  const parts = path.split("/").filter(Boolean);
  let best: Surface | null = null;
  for (const s of SURFACES) {
    if (!s.web) continue;
    const want = s.web.split("/").filter(Boolean);
    if (want.length !== parts.length) continue;
    const hit = want.every((w, i) => (w.startsWith("[") && w.endsWith("]") ? true : w === parts[i]));
    if (hit && (!best || (best.web ?? "").length < s.web.length)) best = s;
  }
  return best;
}

/** 所有被声明用到的端点，去重。`tests/tui-parity.test.ts` 拿它对着目录查 */
export function declaredEndpoints(): string[] {
  return [...new Set(SURFACES.flatMap((s) => s.api))].sort();
}
