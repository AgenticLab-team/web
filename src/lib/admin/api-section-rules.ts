import type { PermissionKey } from "@/lib/rbac/permissions";

/**
 * 后台三十个分区的**名字、说明、权限点**。纯数据，不 import 任何服务端东西。
 *
 * ═════════════════════════════════════════
 * 为什么和 `api-registry.ts` 拆开
 * ═════════════════════════════════════════
 *
 * 注册表那一份要 import 三十个查询函数和一百来个动作函数 ——
 * 也就是说它拖着整个数据库、上游客户端、环境变量。
 *
 * 而对齐守卫（`tests/tui-parity.test.ts`）只需要知道
 * 「有哪几个分区、各要什么权限」。让它 import 那一份的话，
 * 一条纯结构的测试会因为**没配 NEKOBOT_API_KEY** 而挂 ——
 * 而那句报错和它要守的东西毫无关系，
 * 下一个人只会把这条测试删掉。
 *
 * 这就是这个仓库把纯规则拆成 `*-rules.ts` 的那条规矩
 * （`ARCHITECTURE.md` 第一节）：**纯逻辑要能密集地测**。
 *
 * 两份不会分叉：`api-registry.ts` 按这张表逐条组装，
 * 少一个或多一个都有测试盯着。
 */

export interface AdminSectionMeta {
  key: string;
  label: string;
  /** 一句话：这一页是用来回答什么问题的 */
  description: string;
  /** 列分区时用的权限点。真正的判定在动作函数里 */
  permission: PermissionKey;
}

export const ADMIN_SECTION_META: readonly AdminSectionMeta[] = [
  { key: "dashboard", label: "仪表盘", description: "活跃度、系统健康、磁盘水位", permission: "system.dashboard" },
  { key: "health", label: "健康与告警", description: "坏了的时候，有人会知道吗", permission: "system.dashboard" },
  { key: "storage", label: "存储与裁剪", description: "空间花在哪，裁掉的还找不找得回来", permission: "system.storage" },
  { key: "backup", label: "备份与异地副本", description: "明天服务器没了，站还回不回得来", permission: "system.dashboard" },
  { key: "audit", label: "审计日志", description: "谁在什么时候做了什么", permission: "audit.read" },
  { key: "users", label: "用户", description: "封禁、加减分、发身份组、踢下线", permission: "user.list" },
  { key: "user", label: "用户详情", description: "一个人的全部：积分、身份组、处罚、设备、称号", permission: "user.detail.read" },
  { key: "binds", label: "绑定队列", description: "谁在等着把微信号和账号连起来", permission: "user.bind.approve" },
  { key: "roles", label: "身份组与权限矩阵", description: "谁能做什么", permission: "role.manage" },
  { key: "invites", label: "邀请码", description: "谁请来的谁", permission: "invite.manage" },
  { key: "reports", label: "举报队列", description: "有人举报了什么，处理到哪一步了", permission: "moderation.queue" },
  { key: "appeals", label: "申诉", description: "被处罚的人说了什么", permission: "moderation.appeal" },
  { key: "posts", label: "帖子管理", description: "批量删帖、移版块、加精", permission: "forum.post.delete.any" },
  { key: "escalation", label: "升级处置", description: "需要第二个人点头的那些处罚", permission: "forum.visibility.review" },
  { key: "approvals", label: "审批队列", description: "需要走审批的后台操作", permission: "system.approval" },
  { key: "words", label: "敏感词", description: "拦什么、怎么拦", permission: "moderation.words" },
  { key: "boards", label: "版块", description: "版块、可见性、版主、标签", permission: "forum.board.manage" },
  { key: "groups", label: "群与同步", description: "同步开关、游标、失败的任务", permission: "group.manage" },
  { key: "points", label: "积分总览", description: "发了多少、谁拿得多、每日上限压不压得住", permission: "points.read" },
  { key: "points-ledger", label: "积分流水", description: "每一笔从哪来、到哪去", permission: "points.read" },
  { key: "points-levels", label: "等级", description: "几分升一级、每级解锁什么", permission: "points.rules.manage" },
  { key: "shop", label: "商店管理", description: "上架、库存、发货", permission: "shop.manage" },
  { key: "activities", label: "活动管理", description: "活动、报名、资格、导出", permission: "activity.manage" },
  { key: "broadcast", label: "群发", description: "站长往群里说话的唯一入口", permission: "broadcast.wechat" },
  { key: "community", label: "社区健康", description: "新人留没留下、谁在边缘", permission: "system.dashboard" },
  { key: "settings", label: "系统设置", description: "数值与阈值，改一次留一条历史", permission: "system.settings" },
  { key: "flags", label: "功能开关", description: "整块功能的开关。关掉之后导航消失、页面 404", permission: "system.flags" },
  { key: "modules", label: "模块", description: "可插拔的玩法。关掉之后连后台任务都不跑", permission: "module.toggle" },
  { key: "api", label: "开放 API 管理", description: "逐群代发授权、代发日志、SSH 网关令牌", permission: "system.settings" },
  { key: "llm", label: "LLM", description: "配没配、通不通、链接摘要跑到哪了", permission: "system.dashboard" },
  /*
   * 下面两条是两个功能分支合进来时补的。
   *
   * 它们本来各自都是绿的：邮件那边网页全做完了，终端那边所有守卫也全绿 ——
   * 因为**它压根不知道有邮件这一页**。两边一合，
   * `tests/tui-parity.test.ts` 当场红了四条。
   *
   * 这正是那张表存在的理由：一个没人想过的缺口不会有任何症状。
   */
  { key: "mail", label: "邮箱与域名池", description: "域名、箱子、拦下来的信", permission: "mail.domain.read" },
  { key: "oauth", label: "OAuth 应用", description: "谁能拿站里的账号去登录别的地方", permission: "system.settings" },
];

export const ADMIN_SECTION_KEYS: readonly string[] = ADMIN_SECTION_META.map((s) => s.key);
