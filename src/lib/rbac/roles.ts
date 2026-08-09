import { PERMISSION_KEYS, type PermissionKey } from "./permissions";

export interface RoleDef {
  key: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  priority: number;
  /** "*" 表示全部权限点 */
  permissions: readonly PermissionKey[] | "*";
  /** 显式拒绝，优先级高于任何允许 */
  denies?: readonly PermissionKey[];
}

/** 已登录成员的基础能力 */
const MEMBER: readonly PermissionKey[] = [
  "forum.post.create",
  "forum.reply.create",
  "forum.post.edit.own",
  "forum.post.delete.own",
  "group.messages.read",
  "group.stats.read",
  "activity.view",
  "activity.apply",
];

/**
 * 未登录访客。
 *
 * 这里**故意不放「浏览论坛」** —— 论坛对访客开不开由
 * `site.forum_public` 那个配置说了算，不是由权限点。
 * 两处都能管的话，管理员关掉了开关而这里还给着权限，
 * 谁也说不清最后哪一个赢。
 */
const GUEST: readonly PermissionKey[] = ["activity.view"];

/** 外部用户：可以参与论坛，但永远看不到任何群消息派生内容 */
const EXTERNAL: readonly PermissionKey[] = [
  "forum.post.create",
  "forum.reply.create",
  "forum.post.edit.own",
  "forum.post.delete.own",
  "activity.view",
];

const MODERATOR: readonly PermissionKey[] = [
  ...MEMBER,
  "forum.post.edit.any",
  "forum.post.delete.any",
  "forum.post.feature",
  "forum.post.pin",
  "forum.post.lock",
  "forum.post.move",
  "moderation.queue",
  "moderation.action",
  "user.detail.read",
  "user.note.write",
];

const GROUP_ADMIN: readonly PermissionKey[] = [
  ...MEMBER,
  "group.manage",
  // 手动触发同步从 group.manage 里拆出来之后，群管理不能跟着丢掉它。
  // 查看群统计不用写：它在 MEMBER 里，而这里 `...MEMBER` 展开过了
  "group.sync.trigger",
  "user.list",
  "user.detail.read",
  "user.note.write",
  "moderation.queue",
  "moderation.action",
  "announce.site",
];

const AUDITOR: readonly PermissionKey[] = [
  "activity.view",
  "user.list",
  "user.detail.read",
  "points.read",
  "role.read",
  "module.read",
  "system.dashboard",
  "audit.read",
  "group.stats.read",
];

/** 管理员：日常运营全覆盖，但碰不了系统底座与身份组顶层 */
const ADMIN_DENIES: readonly PermissionKey[] = [
  "system.settings",
  "role.grant.admin",
  "permission.override",
  "user.delete",
  "user.merge",
  "module.install",
  /*
   * 以他人身份预览留给站长。
   *
   * 权限上它伤不到管理员自己（预览只减不增，看到的不会超过他本来能看的），
   * 但**隐私上会**：切成一个普通成员之后，看到的是他的群列表、
   * 他的通知、他的私人视角 —— 而「群列表属于隐私」是这个站的明规矩。
   *
   * 其余 dangerLevel 3 的权限点都在这张表里，这一条没有理由例外。
   * 需要放开的话在后台权限矩阵里单独授予，那一步本身会进审计日志。
   */
  "system.impersonate",
];

const ADMIN = PERMISSION_KEYS.filter(
  (key) => !ADMIN_DENIES.includes(key),
) as PermissionKey[];

export const BUILTIN_ROLES: readonly RoleDef[] = [
  {
    key: "owner",
    name: "站长",
    description: "全部权限。唯一可以授予管理员、修改系统设置的角色",
    color: "#B45309",
    icon: "crown",
    priority: 100,
    permissions: "*",
  },
  {
    key: "admin",
    name: "管理员",
    description: "用户、内容、活动、积分、公告全覆盖；不能改系统设置或授予管理员",
    color: "#B91C1C",
    icon: "shield",
    priority: 90,
    permissions: ADMIN,
    denies: ADMIN_DENIES,
  },
  {
    key: "moderator",
    name: "版主",
    description: "限定版块内的内容审核",
    color: "#1D4ED8",
    icon: "gavel",
    priority: 70,
    permissions: MODERATOR,
  },
  {
    key: "group_admin",
    name: "群管理",
    description: "限定群的成员管理、榜单与群相关公告",
    color: "#047857",
    icon: "users",
    priority: 60,
    permissions: GROUP_ADMIN,
  },
  {
    key: "auditor",
    name: "审计员",
    description: "全站只读，含审计日志。零写权限 —— 让「看数据」不需要给写权限",
    color: "#6D28D9",
    icon: "eye",
    priority: 50,
    permissions: AUDITOR,
  },
  {
    key: "member",
    name: "成员",
    description: "已绑定微信的群成员",
    color: "#0F172A",
    icon: "user",
    priority: 10,
    permissions: MEMBER,
  },
  {
    key: "external",
    name: "外部用户",
    description: "未在群内。可参与论坛，看不到任何群消息派生内容",
    color: "#64748B",
    icon: "user-minus",
    priority: 5,
    permissions: EXTERNAL,
  },
  {
    key: "guest",
    name: "访客",
    description: "未登录。只能浏览公开内容",
    color: "#94A3B8",
    icon: "globe",
    priority: 1,
    permissions: GUEST,
  },
  {
    key: "banned",
    name: "封禁",
    description: "禁止登录与一切操作",
    color: "#7F1D1D",
    icon: "ban",
    priority: 0,
    permissions: [],
  },
];

export const BUILTIN_ROLE_KEYS = BUILTIN_ROLES.map((r) => r.key);

/**
 * 一个角色最终拿到的权限点。
 *
 * ─────────────────────────────────────────
 * 去重是必须的，不是防御性编程
 * ─────────────────────────────────────────
 *
 * 几个角色是靠 `...MEMBER` 展开再补几条写出来的，
 * 补的时候很容易补进一条 MEMBER 里已经有的 ——
 * 而 `role_permissions` 上有 (role_id, permission_key) 的唯一约束，
 * 于是 seed 直接抛异常。
 *
 * **seed 是开机跑的**：一条重复的权限点会让整个站起不来，
 * 而报错信息只说「UNIQUE constraint failed」，看不出是哪个角色。
 *
 * 这不是假想 —— 给群管理补 `group.stats.read` 的时候真的撞了一次。
 */
export function resolveRolePermissions(role: RoleDef): PermissionKey[] {
  const all = role.permissions === "*" ? PERMISSION_KEYS : role.permissions;
  return [...new Set(all)];
}
