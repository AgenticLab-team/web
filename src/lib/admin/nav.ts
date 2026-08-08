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
        description: "档案、积分、封禁、绑定审批",
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
        ready: false,
      },
    ],
  },
  {
    key: "content",
    label: "内容",
    items: [
      {
        key: "moderation",
        href: "/admin/moderation",
        label: "举报与审核",
        icon: "flag",
        permission: "moderation.queue",
        ready: false,
      },
      {
        key: "appeals",
        href: "/admin/appeals",
        label: "申诉处理",
        icon: "scale",
        permission: "moderation.appeal",
        ready: false,
      },
      {
        key: "boards",
        href: "/admin/boards",
        label: "版块与标签",
        icon: "layout-list",
        permission: "forum.board.manage",
        ready: false,
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
        label: "积分与等级",
        icon: "coins",
        permission: "points.rules.manage",
        ready: false,
      },
      {
        key: "groups",
        href: "/admin/groups",
        label: "群与数据源",
        icon: "message-square",
        permission: "group.manage",
        ready: false,
      },
      {
        key: "broadcast",
        href: "/admin/broadcast",
        label: "公告与群发",
        icon: "megaphone",
        permission: "announce.site",
        ready: false,
      },
    ],
  },
  {
    key: "system",
    label: "系统",
    items: [
      {
        key: "settings",
        href: "/admin/settings",
        label: "系统设置",
        icon: "sliders",
        permission: "system.settings",
        ready: false,
      },
      {
        key: "approvals",
        href: "/admin/approvals",
        label: "危险操作复核",
        icon: "shield-check",
        permission: "system.approval",
        ready: false,
      },
      {
        key: "modules",
        href: "/admin/modules",
        label: "模块",
        icon: "puzzle",
        permission: "module.read",
        ready: false,
      },
    ],
  },
];

export function visibleAdminNav(has: (permission: PermissionKey) => boolean): AdminNavSection[] {
  return ADMIN_NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => has(item.permission)),
  })).filter((section) => section.items.length > 0);
}

export const ALL_ADMIN_ITEMS = ADMIN_NAV.flatMap((s) => s.items);
