/**
 * 权限点字典。代码是唯一真源，启动时同步进 permissions 表供后台展示。
 *
 * dangerLevel:
 *   0 普通
 *   1 敏感 —— 后台标记，进审计日志
 *   2 危险 —— 需要重新验证身份（不是弹窗点确认）
 *   3 极危 —— 需要另一名管理员双人复核（approvals）
 */

export interface PermissionDef {
  key: string;
  category: string;
  label: string;
  description?: string;
  scopable?: boolean;
  dangerLevel?: 0 | 1 | 2 | 3;
}

export const PERMISSIONS = [
  // ── 内容浏览 ────────────────────────────────────────────────
  { key: "forum.view", category: "forum", label: "浏览论坛" },
  { key: "forum.post.create", category: "forum", label: "发帖", scopable: true },
  { key: "forum.reply.create", category: "forum", label: "回复", scopable: true },
  { key: "forum.react", category: "forum", label: "点赞收藏" },
  { key: "forum.post.edit.own", category: "forum", label: "编辑自己的帖子" },
  { key: "forum.post.edit.any", category: "forum", label: "编辑任何帖子", scopable: true, dangerLevel: 1 },
  { key: "forum.post.delete.own", category: "forum", label: "删除自己的帖子" },
  { key: "forum.post.delete.any", category: "forum", label: "删除任何帖子", scopable: true, dangerLevel: 1 },
  { key: "forum.post.feature", category: "forum", label: "加精", scopable: true },
  { key: "forum.post.pin", category: "forum", label: "置顶", scopable: true },
  { key: "forum.post.lock", category: "forum", label: "锁定", scopable: true },
  { key: "forum.post.move", category: "forum", label: "移动版块", scopable: true },
  {
    key: "forum.post.visibility.raise",
    category: "forum",
    label: "提升帖子可见性",
    description: "把群聊转帖提升到成员可见或公开。需原作者同意，操作单独留痕",
    dangerLevel: 2,
  },
  { key: "forum.board.manage", category: "forum", label: "管理版块", dangerLevel: 1 },
  {
    key: "forum.visibility.review",
    category: "forum",
    label: "审核可见性提升",
    description: "群聊转帖想让更多人看到时走这里。通过后扩散不可逆",
    dangerLevel: 2,
  },
  {
    key: "forum.tag.manage",
    category: "forum",
    label: "管理标签",
    description: "合并、重命名、锁定、清理。合并不可撤销",
    dangerLevel: 1,
  },

  // ── 群消息 ──────────────────────────────────────────────────
  {
    key: "group.messages.read",
    category: "group",
    label: "查看群消息",
    description: "按 scope 限定到具体的群；无 scope 不生效",
    scopable: true,
  },
  { key: "group.stats.read", category: "group", label: "查看群统计", scopable: true },
  { key: "group.manage", category: "group", label: "管理群配置", scopable: true, dangerLevel: 1 },
  { key: "group.sync.trigger", category: "group", label: "手动触发同步", dangerLevel: 1 },

  // ── 用户 ────────────────────────────────────────────────────
  { key: "user.list", category: "user", label: "查看用户列表" },
  { key: "user.detail.read", category: "user", label: "查看用户详情" },
  { key: "user.note.write", category: "user", label: "给用户写备注" },
  {
    key: "user.title.grant",
    category: "user",
    label: "授予与收回称号",
    description: "稀有称号有名额上限，发出去就收不回了（收回比不发更伤人）",
    dangerLevel: 1,
  },
  { key: "user.bind.approve", category: "user", label: "审批绑定申请", dangerLevel: 1 },
  { key: "user.bind.manual", category: "user", label: "手动绑定用户", dangerLevel: 2 },
  { key: "user.session.revoke", category: "user", label: "远程下线用户", dangerLevel: 1 },
  { key: "user.suspend", category: "user", label: "封禁 / 解封", dangerLevel: 2 },
  { key: "user.delete", category: "user", label: "删除账号", dangerLevel: 3 },
  { key: "user.merge", category: "user", label: "合并重复账号", dangerLevel: 3 },
  { key: "user.export", category: "user", label: "导出用户数据", dangerLevel: 2 },

  // ── 身份组与权限 ────────────────────────────────────────────
  { key: "role.read", category: "role", label: "查看身份组" },
  { key: "role.manage", category: "role", label: "创建 / 编辑身份组", dangerLevel: 2 },
  { key: "role.grant", category: "role", label: "授予 / 撤销身份组", scopable: true, dangerLevel: 2 },
  { key: "role.grant.admin", category: "role", label: "授予管理员", dangerLevel: 3 },
  { key: "permission.override", category: "role", label: "设置用户级权限例外", dangerLevel: 3 },

  // ── 积分 ────────────────────────────────────────────────────
  { key: "points.read", category: "points", label: "查看积分流水" },
  { key: "points.adjust", category: "points", label: "手动调整积分", dangerLevel: 2 },
  { key: "points.adjust.large", category: "points", label: "大额积分调整", dangerLevel: 3 },
  { key: "points.rules.manage", category: "points", label: "配置积分规则", dangerLevel: 2 },
  { key: "points.recount", category: "points", label: "重算积分", dangerLevel: 2 },
  { key: "badge.manage", category: "points", label: "管理徽章", dangerLevel: 1 },

  // ── 审核 ────────────────────────────────────────────────────
  { key: "moderation.queue", category: "moderation", label: "处理举报队列" },
  { key: "moderation.action", category: "moderation", label: "执行处罚", scopable: true, dangerLevel: 1 },
  { key: "moderation.appeal", category: "moderation", label: "处理申诉", dangerLevel: 1 },
  { key: "moderation.words", category: "moderation", label: "管理敏感词库", dangerLevel: 1 },

  // ── 活动与模块 ──────────────────────────────────────────────
  { key: "activity.view", category: "activity", label: "查看活动" },
  { key: "activity.apply", category: "activity", label: "报名 / 申请活动" },
  { key: "activity.manage", category: "activity", label: "创建 / 编辑活动", dangerLevel: 1 },
  { key: "activity.review", category: "activity", label: "审核活动申请", scopable: true, dangerLevel: 1 },
  { key: "activity.fulfill", category: "activity", label: "履约与批量回填", scopable: true, dangerLevel: 2 },
  { key: "module.read", category: "module", label: "查看模块" },
  { key: "module.toggle", category: "module", label: "启用 / 停用模块", dangerLevel: 2 },
  { key: "module.install", category: "module", label: "安装 / 卸载模块", dangerLevel: 3 },
  { key: "module.config", category: "module", label: "配置模块", dangerLevel: 2 },

  // ── 商店 ────────────────────────────────────────────────────
  { key: "shop.manage", category: "shop", label: "管理商品", dangerLevel: 1 },
  { key: "shop.order.handle", category: "shop", label: "处理兑换订单", dangerLevel: 1 },

  // ── 公告与推送 ──────────────────────────────────────────────
  { key: "announce.site", category: "broadcast", label: "发布站内公告", dangerLevel: 1 },
  {
    key: "broadcast.wechat",
    category: "broadcast",
    label: "向微信群发送消息",
    description: "仅系统与管理员行为，网站永不代用户发消息",
    dangerLevel: 3,
  },
  {
    key: "broadcast.approve",
    category: "broadcast",
    label: "复核群发",
    description: "双人复核的第二个人。起草人不能自己批准自己的稿子",
    dangerLevel: 2,
  },
  { key: "broadcast.email", category: "broadcast", label: "群发邮件", dangerLevel: 3 },
  { key: "digest.manage", category: "broadcast", label: "管理每周精选推送", dangerLevel: 1 },

  // ── 系统 ────────────────────────────────────────────────────
  { key: "system.dashboard", category: "system", label: "查看后台总览" },
  { key: "audit.read", category: "system", label: "查看审计日志" },
  { key: "system.settings", category: "system", label: "修改系统设置", dangerLevel: 3 },
  { key: "system.flags", category: "system", label: "开关功能模块", dangerLevel: 2 },
  { key: "system.storage", category: "system", label: "存储裁剪与运维", dangerLevel: 2 },
  { key: "system.approval", category: "system", label: "复核危险操作", dangerLevel: 2 },
  { key: "invite.manage", category: "system", label: "管理邀请码", dangerLevel: 1 },
] as const satisfies readonly PermissionDef[];

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key) as PermissionKey[];

const byKey = new Map(PERMISSIONS.map((p) => [p.key as string, p as PermissionDef]));

export function getPermission(key: string): PermissionDef | undefined {
  return byKey.get(key);
}

export function dangerLevelOf(key: string): number {
  return byKey.get(key)?.dangerLevel ?? 0;
}
