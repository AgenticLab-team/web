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
  /**
   * 这个权限点今天到底管不管用。
   *
   * ─────────────────────────────────────────
   * 70 个里有 18 个从来没被判定过
   * ─────────────────────────────────────────
   *
   * 后台把 70 个勾一视同仁地摆出来，看起来每一个都管事 ——
   * 而其中 18 个从来没有被传进任何一次判定。也就是说：
   * 给一个人勾上它，什么都不会发生；把它取消掉，
   * 那个人照样做得了那件事。
   *
   * 这是这个仓库的地方病（死开关）在权限表上的形态，
   * 而且它比别处更糟：**权限是拿来限制人的东西，
   * 一个不生效的限制会让人以为已经限制住了。**
   *
   * `planned` 的两种来源：
   *   · 功能还没做（导出、合并账号、邮件群发…）
   *   · 功能做了，但代码用的是另一个更粗的权限点在管
   *     （开关页要的是 `system.settings`，而不是这里的 `system.flags`）
   *
   * 后一种更值得警惕：它意味着**细粒度的授权做不到** ——
   * 想给一个人「只能开关功能、不能改设置」，今天办不到。
   *
   * 有一条测试逐个核对：标着 wired 的必须真的出现在某次判定里。
   * 所以这个字段不会慢慢变成谎话。
   */
  status?: "wired" | "planned";
}

export const PERMISSIONS = [
  // ── 内容浏览 ────────────────────────────────────────────────
  { key: "forum.view", category: "forum", label: "浏览论坛", description: "论坛的可见性今天由版块的 visible_to 和功能开关在管，没有单独判它", status: "planned" },
  { key: "forum.post.create", category: "forum", label: "发帖", scopable: true },
  { key: "forum.reply.create", category: "forum", label: "回复", scopable: true },
  { key: "forum.react", category: "forum", label: "点赞收藏", description: "点赞收藏目前只判登录，没有单独判它", status: "planned" },
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
  { key: "group.stats.read", category: "group", label: "查看群统计", scopable: true, description: "群统计页今天由 group.manage 一起管", status: "planned" },
  { key: "group.manage", category: "group", label: "管理群配置", scopable: true, dangerLevel: 1 },
  { key: "group.sync.trigger", category: "group", label: "手动触发同步", dangerLevel: 1, description: "手动触发同步今天由 group.manage 一起管", status: "planned" },

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
  { key: "user.delete", category: "user", label: "删除账号", dangerLevel: 3, status: "planned" },
  { key: "user.merge", category: "user", label: "合并重复账号", dangerLevel: 3, status: "planned" },
  { key: "user.export", category: "user", label: "导出用户数据", dangerLevel: 2, status: "planned" },

  // ── 身份组与权限 ────────────────────────────────────────────
  { key: "role.read", category: "role", label: "查看身份组" },
  { key: "role.manage", category: "role", label: "创建 / 编辑身份组", dangerLevel: 2 },
  { key: "role.grant", category: "role", label: "授予 / 撤销身份组", scopable: true, dangerLevel: 2 },
  { key: "role.grant.admin", category: "role", label: "授予管理员", dangerLevel: 3 },
  { key: "permission.override", category: "role", label: "设置用户级权限例外", dangerLevel: 3, status: "planned" },

  // ── 积分 ────────────────────────────────────────────────────
  { key: "points.read", category: "points", label: "查看积分流水" },
  { key: "points.adjust", category: "points", label: "手动调整积分", dangerLevel: 2 },
  { key: "points.adjust.large", category: "points", label: "大额积分调整", dangerLevel: 3 },
  { key: "points.rules.manage", category: "points", label: "配置积分规则", dangerLevel: 2 },
  { key: "points.recount", category: "points", label: "重算积分", dangerLevel: 2 },
  { key: "badge.manage", category: "points", label: "管理徽章", dangerLevel: 1, status: "planned" },

  // ── 审核 ────────────────────────────────────────────────────
  { key: "moderation.queue", category: "moderation", label: "处理举报队列" },
  { key: "moderation.action", category: "moderation", label: "执行处罚", scopable: true, dangerLevel: 1, description: "处罚今天判的是 user.suspend", status: "planned" },
  { key: "moderation.appeal", category: "moderation", label: "处理申诉", dangerLevel: 1 },
  { key: "moderation.words", category: "moderation", label: "管理敏感词库", dangerLevel: 1 },

  // ── 活动与模块 ──────────────────────────────────────────────
  { key: "activity.view", category: "activity", label: "查看活动", description: "活动页今天由功能开关在管", status: "planned" },
  { key: "activity.apply", category: "activity", label: "报名 / 申请活动", description: "报名今天只判登录", status: "planned" },
  { key: "activity.manage", category: "activity", label: "创建 / 编辑活动", dangerLevel: 1 },
  { key: "activity.review", category: "activity", label: "审核活动申请", scopable: true, dangerLevel: 1 },
  { key: "activity.fulfill", category: "activity", label: "履约与批量回填", scopable: true, dangerLevel: 2 },
  { key: "module.read", category: "module", label: "查看模块" },
  { key: "module.toggle", category: "module", label: "启用 / 停用模块", dangerLevel: 2 },
  { key: "module.install", category: "module", label: "安装 / 卸载模块", dangerLevel: 3, status: "planned" },
  { key: "module.config", category: "module", label: "配置模块", dangerLevel: 2, status: "planned" },

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
  { key: "broadcast.email", category: "broadcast", label: "群发邮件", dangerLevel: 3, status: "planned" },
  { key: "digest.manage", category: "broadcast", label: "管理每周精选推送", dangerLevel: 1, description: "每周精选今天由 announce.site 一起管", status: "planned" },

  // ── 系统 ────────────────────────────────────────────────────
  { key: "system.dashboard", category: "system", label: "查看后台总览" },
  { key: "audit.read", category: "system", label: "查看审计日志" },
  { key: "system.settings", category: "system", label: "修改系统设置", dangerLevel: 3 },
  { key: "system.flags", category: "system", label: "开关功能模块", dangerLevel: 2 },
  { key: "system.storage", category: "system", label: "存储裁剪与运维", dangerLevel: 2 },
  { key: "system.approval", category: "system", label: "复核危险操作", dangerLevel: 2 },
  {
    key: "system.impersonate",
    category: "system",
    label: "以他人身份预览",
    description: "只读地切成别人的视角。权限只减不增，且预览态下不能写入任何数据。",
    dangerLevel: 3,
  },
  { key: "invite.manage", category: "system", label: "管理邀请码", dangerLevel: 1 },
] as const satisfies readonly PermissionDef[];

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key) as PermissionKey[];

/**
 * 同一份表，只是标成了 `PermissionDef`。
 *
 * `PERMISSIONS` 故意不加类型注解 —— 加了的话 `PermissionKey`
 * 就会从一串字面量退化成 `string`，全站的权限点拼写检查一起失效。
 * 但要按 `status` / `description` 这些可选字段过滤时，
 * 那个字面量联合类型用起来很别扭（没有该字段的成员上根本没有这个属性）。
 * 所以留一个类型化的视图给那种用法。
 */
export const PERMISSION_LIST: readonly PermissionDef[] = PERMISSIONS;

const byKey = new Map(PERMISSIONS.map((p) => [p.key as string, p as PermissionDef]));

export function getPermission(key: string): PermissionDef | undefined {
  return byKey.get(key);
}

export function dangerLevelOf(key: string): number {
  return byKey.get(key)?.dangerLevel ?? 0;
}
