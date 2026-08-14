import type { PermissionKey } from "@/lib/rbac/permissions";

/**
 * 后台导航。与前台一样是**单一真源**，
 * 每一项声明自己需要的权限点，由 has() 逐项过滤。
 *
 * 声明式的好处：加一个后台页面时，忘记配权限的结果是「谁都看不到」，
 * 而不是「谁都能看」。
 */

export interface AdminNavItem {
  key: string;
  href: string;
  label: string;
  icon: string;
  permission: PermissionKey;
  /**
   * 还有哪些权限点也够进这一页。
   *
   * 一页上有两种人要看的东西时（群页：配置归 `group.manage`，
   * 规模数字归 `group.stats.read`），导航只认主权限点的后果是
   * 另一批人**在导航里根本看不到这一页** —— 而页面那一侧其实放行。
   * 那个权限点于是等于不存在。
   */
  alsoAllows?: readonly PermissionKey[];
  description?: string;
  ready?: boolean;
}

export interface AdminNavSection {
  key: string;
  label: string;
  items: AdminNavItem[];
}

export const ADMIN_NAV: AdminNavSection[] = [
  {
    key: "overview",
    label: "总览",
    items: [
      {
        key: "dashboard",
        href: "/admin",
        label: "仪表盘",
        icon: "gauge",
        permission: "system.dashboard",
        description: "活跃度、系统健康、磁盘水位",
        ready: true,
      },
      {
        key: "health",
        href: "/admin/health",
        label: "健康与告警",
        icon: "activity",
        permission: "system.dashboard",
        description: "坏了的时候，有人会知道吗",
        ready: true,
      },
      {
        key: "storage",
        href: "/admin/storage",
        label: "存储与裁剪",
        icon: "hard-drive",
        permission: "system.dashboard",
        description: "空间花在哪，裁掉的还找不找得回来",
        ready: true,
      },
      {
        key: "backup",
        href: "/admin/backup",
        label: "备份与异地副本",
        icon: "cloud-upload",
        permission: "system.dashboard",
        description: "明天服务器没了，站还回不回得来",
        ready: true,
      },
      {
        key: "audit",
        href: "/admin/audit",
        label: "审计日志",
        icon: "scroll-text",
        permission: "audit.read",
        description: "谁在什么时候改了什么",
        ready: true,
      },
    ],
  },
  {
    key: "people",
    label: "人",
    items: [
      {
        key: "users",
        href: "/admin/users",
        label: "用户管理",
        icon: "users",
        permission: "user.list",
        description: "档案、积分、封禁、登录与设备",
        ready: true,
      },
      {
        key: "binds",
        href: "/admin/binds",
        label: "绑定审批",
        icon: "user-plus",
        permission: "user.bind.approve",
        description: "卡住的绑定、好友申请与申请人活跃度",
        ready: true,
      },
      {
        key: "roles",
        href: "/admin/roles",
        label: "身份组与权限",
        icon: "shield",
        permission: "role.read",
        description: "权限矩阵、权限反查",
        ready: true,
      },
      {
        key: "invites",
        href: "/admin/invites",
        label: "邀请码",
        icon: "ticket",
        permission: "invite.manage",
        description: "码、邀请树、奖励结算与回滚",
        ready: true,
      },
    ],
  },
  {
    key: "content",
    label: "内容",
    items: [
      {
        key: "moderation",
        href: "/admin/reports",
        label: "举报队列",
        icon: "flag",
        permission: "moderation.queue",
        description: "按目标归组，超时的排最前",
        ready: true,
      },
      {
        key: "appeals",
        href: "/admin/appeals",
        label: "申诉处理",
        icon: "scale",
        permission: "moderation.appeal",
        description: "原处罚理由与申诉说法并排",
        ready: true,
      },
      {
        key: "posts",
        href: "/admin/posts",
        label: "内容管理",
        icon: "file-text",
        permission: "forum.post.delete.any",
        description: "搜索、筛选、批量处置",
        ready: true,
      },
      {
        key: "escalation",
        href: "/admin/escalation",
        label: "可见性提升",
        icon: "eye",
        permission: "forum.visibility.review",
        description: "群聊转帖想让更多人看到",
        ready: true,
      },
      {
        key: "words",
        href: "/admin/words",
        label: "敏感词",
        icon: "filter",
        permission: "moderation.words",
        description: "三档处置，带预览器",
        ready: true,
      },
      {
        key: "boards",
        href: "/admin/boards",
        label: "版块与标签",
        icon: "layout-list",
        permission: "forum.board.manage",
        description: "可见性封顶、层级、标签合并",
        ready: true,
      },
    ],
  },
  {
    key: "operations",
    label: "运营",
    items: [
      {
        key: "points",
        href: "/admin/points",
        label: "积分经济",
        icon: "coins",
        permission: "points.rules.manage",
        description: "发行、回收、通胀体检",
        ready: true,
      },
      {
        key: "levels",
        href: "/admin/points/levels",
        label: "等级门槛",
        icon: "trending-up",
        permission: "points.rules.manage",
        description: "每级需要多少分、解锁了哪些版块",
        ready: true,
      },
      {
        key: "ledger",
        href: "/admin/points/ledger",
        label: "积分流水",
        icon: "receipt",
        // points.read 这个权限一直没人用 —— 它管的就是这一页
        permission: "points.read",
        description: "全站流水、风控队列、冲正",
        ready: true,
      },
      {
        key: "community",
        href: "/admin/community",
        label: "社群健康度",
        icon: "activity",
        permission: "group.manage",
        alsoAllows: ["group.stats.read"],
        description: "活跃趋势、发言集中度、沉默比例、退潮预警",
        ready: true,
      },
      {
        key: "groups",
        href: "/admin/groups",
        label: "群与数据源",
        icon: "message-square",
        permission: "group.manage",
        alsoAllows: ["group.stats.read"],
        description: "接入状态、同步健康、每群配置",
        ready: true,
      },
      {
        key: "shop",
        href: "/admin/shop",
        label: "商店与订单",
        icon: "shopping-bag",
        permission: "shop.manage",
        description: "积分的主要回收口",
        ready: true,
      },
      {
        key: "mail",
        href: "/admin/mail",
        label: "邮箱与域名池",
        icon: "mail",
        permission: "mail.domain.read",
        alsoAllows: ["mail.domain.write", "mail.box.read", "mail.box.write", "mail.banword"],
        description: "100 个域名的归属、到期与 DNS 体检",
        ready: true,
      },
      {
        key: "broadcast",
        href: "/admin/broadcast",
        label: "公告与群发",
        icon: "megaphone",
        permission: "announce.site",
        description: "双人复核，逐群留痕",
        ready: true,
      },
    ],
  },
  {
    key: "system",
    label: "系统",
    items: [
      {
        key: "flags",
        href: "/admin/flags",
        label: "功能开关",
        icon: "toggle-left",
        permission: "system.settings",
        description: "出问题时先关模块，而不是回滚整站",
        ready: true,
      },
      {
        key: "settings",
        href: "/admin/settings",
        label: "系统设置",
        icon: "sliders",
        permission: "system.settings",
        description: "变更历史与回滚",
        ready: true,
      },
      {
        key: "api",
        href: "/admin/api",
        label: "开放 API",
        icon: "sparkles",
        permission: "system.settings",
        description: "谁能借机器人的嘴说话，以及他们说了什么",
        ready: true,
      },
      {
        key: "llm",
        href: "/admin/llm",
        label: "模型接入",
        icon: "sparkles",
        permission: "system.settings",
        description: "对话与嵌入是否真的通、资源库整理进度",
        ready: true,
      },
      {
        key: "approvals",
        href: "/admin/approvals",
        label: "危险操作留痕",
        icon: "shield-check",
        permission: "system.approval",
        description: "改错了不会有人立刻发现的那些操作（可选，不强制）",
        ready: true,
      },
      {
        key: "activities",
        href: "/admin/activities",
        label: "活动",
        icon: "gift",
        permission: "activity.manage",
        description: "资格规则、名额、审批与履约",
        ready: true,
      },
      {
        key: "modules",
        href: "/admin/modules",
        label: "模块与健康度",
        icon: "puzzle",
        permission: "module.read",
        description: "每个开关都真的关得掉某样东西",
        ready: true,
      },
    ],
  },
];

export function visibleAdminNav(has: (permission: PermissionKey) => boolean): AdminNavSection[] {
  return ADMIN_NAV.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) => has(item.permission) || (item.alsoAllows ?? []).some(has),
    ),
  })).filter((section) => section.items.length > 0);
}

export const ALL_ADMIN_ITEMS = ADMIN_NAV.flatMap((s) => s.items);
