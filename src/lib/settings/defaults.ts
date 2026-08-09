/**
 * 默认配置。**代码里不许出现魔法数字** —— 一切阈值走这里，后台可改、改动有历史。
 * 这张表就是 SCHEMA.md 里「一切可配」那条规则的落地。
 */

export interface SettingDef {
  key: string;
  value: string;
  type: "string" | "int" | "bool" | "json";
  category: string;
  label: string;
  description?: string;
  min?: number;
  max?: number;
  requiresPermission?: string;
  /**
   * `planned` = 这个旋钮对应的功能还没做，拨它现在不会有任何反应。
   *
   * 不标的话它和真旋钮长得一模一样 —— 管理员拨过去、以为生效了，
   * 而没有任何地方会告诉他没有。标出来之后后台会说明，
   * 测试也不再把它当成「该接没接」。
   */
  status?: "planned";
}

/**
 * ─────────────────────────────────────────
 * 退役的配置项
 * ─────────────────────────────────────────
 *
 * 从 `DEFAULT_SETTINGS` 里删掉**不够** —— 后台那一页列的是
 * 库里的行，不是这份清单。删了清单不删库，结果是那个旋钮
 * 照样摆在后台，而且再也没有人知道它是死的。
 *
 * 所以退役要走这里：seed 每次启动会把这些键从库里删掉。
 *
 * `why` 不是注释，是**给未来的人的答复** —— 「这个配置项去哪了」
 * 这个问题一定会有人问，答案得在代码里，不在某次提交信息里。
 */
export const RETIRED_SETTINGS: readonly { key: string; why: string }[] = [
  {
    key: "digest.auto_send",
    why: "精选**永远只生成草稿**，发送走群发那套复核流程。这是写死的设计（见 lib/digest/build.ts），不是可配的 —— 留着这个旋钮等于承诺一件代码明确拒绝做的事",
  },
  {
    key: "digest.per_group_weekly_limit",
    why: "精选每周产出一份草稿、发一次，「每群每周上限 1」是这个流程的固有性质，不是能拨的东西。真正的发送频率限制在群发那一层（发送间隔、每日上限）",
  },
  {
    key: "site.name",
    why: "站点名来自环境变量 SITE_NAME（env.site.name）—— 它在构建期和没有数据库的地方也要用。两处各存一份的结果是后台改了名字而页面标题不变",
  },
  {
    key: "digest.enabled",
    why: "改名成 `module.digest.enabled`，归进模块登记表 —— 周报是个后台任务，和同步、雷达、裁剪是同一类东西，摆在同一页上才看得出「这个站有哪些定时任务在跑」。旧键留着的话，两个开关名字都在，谁也说不清拨哪个",
  },
] as const;

export const DEFAULT_SETTINGS: readonly SettingDef[] = [
  // ── 绑定与登录 ──────────────────────────────────────────────
  {
    key: "auth.bind_code.ttl_seconds",
    value: "300",
    type: "int",
    category: "auth",
    label: "验证码有效期（秒）",
    description: "群消息通道是公开可见的，TTL 短能压缩被冒用的窗口",
    min: 60,
    max: 1800,
  },
  {
    key: "auth.bind_code.burst_limit",
    value: "5",
    type: "int",
    category: "auth",
    label: "短窗口内同一 IP 可生成验证码次数",
    description: "防爆刷。窗口见 burst_window_seconds",
    min: 1,
    max: 50,
  },
  {
    key: "auth.bind_code.burst_window_seconds",
    value: "600",
    type: "int",
    category: "auth",
    label: "防爆刷窗口（秒）",
    min: 60,
    max: 3600,
  },
  {
    key: "auth.bind_code.daily_limit",
    value: "10",
    type: "int",
    category: "auth",
    label: "同一 IP 每日可生成验证码次数",
    description:
      "注意这是按 IP 不是按人：国内运营商大量用 NAT，一个出口后面可能有几十个群友，阈值定低了会把整栋楼锁在门外",
    min: 5,
    max: 500,
  },
  {
    key: "auth.bind_code.fallback_after_seconds",
    value: "15",
    type: "int",
    category: "auth",
    label: "多少秒后显示「遇到问题」兜底入口",
    min: 5,
    max: 120,
  },
  {
    key: "auth.bind_code.group_prefix",
    value: "登录",
    type: "string",
    category: "auth",
    label: "群消息通道要求的前缀词",
    description: "必须写成「登录 123456」而非裸数字，避免有人被诱导代发验证码导致账号被劫持",
  },
  {
    key: "auth.session.ttl_days",
    value: "30",
    type: "int",
    category: "auth",
    label: "会话有效期（天）",
    min: 1,
    max: 365,
  },
  {
    key: "auth.require_passkey_for_admin",
    value: "true",
    type: "bool",
    category: "auth",
    label: "管理员强制 Passkey 或 2FA",
    description: "管理员账号不接受纯密码登录",
  },
  {
    key: "auth.login.max_attempts_per_hour",
    value: "20",
    type: "int",
    category: "auth",
    label: "每小时最大登录尝试次数",
    min: 3,
    max: 200,
  },

  // ── 积分规则 ────────────────────────────────────────────────
  {
    key: "points.levels",
    /*
     * 等级门槛。**这是全站唯一一个 json 类型的设置** ——
     * 它本来就是一张表，拆成十个整数项的话，改一次要点十次，
     * 而「门槛必须一级比一级高」这条跨行的约束也没地方校验。
     *
     * 值的合法性由 checkLevels 判（递增、L1 为 0、名字非空），
     * 保存前会先算出「多少人会升级、多少人会降级」摆给人看。
     */
    value: JSON.stringify([
      { level: 1, requires: 0, name: "新来的" },
      { level: 2, requires: 50, name: "冒泡" },
      { level: 3, requires: 150, name: "常客" },
      { level: 4, requires: 350, name: "熟面孔" },
      { level: 5, requires: 700, name: "老手" },
      { level: 6, requires: 1200, name: "中坚" },
      { level: 7, requires: 2000, name: "骨干" },
      { level: 8, requires: 3200, name: "元老" },
      { level: 9, requires: 5000, name: "旗手" },
      { level: 10, requires: 8000, name: "传奇" },
    ]),
    type: "json",
    category: "points",
    label: "等级门槛",
    description: "每一级需要多少累计积分。改动会立刻影响所有人的等级，以及按等级卡的版块",
    requiresPermission: "points.rules.manage",
  },
  {
    key: "points.checkin.min_quality_messages",
    value: "3",
    type: "int",
    category: "points",
    label: "打卡所需的当日高质量消息数",
    description: "先有贡献再签到，避免纯签到党",
    min: 0,
    max: 100,
  },
  { key: "points.checkin.base", value: "10", type: "int", category: "points", label: "打卡基础积分" },
  {
    key: "points.quality_bonus.per",
    value: "5",
    type: "int",
    category: "points",
    label: "每多 N 条高质量消息的加分",
  },
  {
    key: "points.quality_bonus.step",
    value: "5",
    type: "int",
    category: "points",
    label: "加分步长（每多少条给一次）",
  },
  {
    key: "points.quality_bonus.daily_cap",
    value: "20",
    type: "int",
    category: "points",
    label: "高质量消息加分每日上限",
  },
  {
    key: "points.checkin.min_forum_units",
    value: "3",
    type: "int",
    category: "points",
    label: "打卡所需的当日论坛活跃度",
    description:
      "与群聊门槛二选一满足即可。只认群聊的话，主要在论坛写长文的人反而打不了卡 —— 而他们沉淀的内容最多",
    min: 0,
    max: 100,
  },
  {
    key: "points.streak.cap",
    value: "30",
    type: "int",
    category: "points",
    label: "连胜奖励上限",
  },

  {
    key: "invite.reward_points",
    value: "50",
    type: "int",
    category: "points",
    label: "邀请奖励积分",
    description:
      "在被邀请人**完成首次打卡**时发放，不是注册时 —— 注册即给的话，拉一堆僵尸号就能刷分。被邀请人被封时会自动冲正",
    min: 0,
    max: 1000,
  },

  // ── 发行闸门（防通胀）──────────────────────────────────────
  //
  // 这一组的作用是**控制发行总量**。积分只发不收的话，一年后
  // 商店价格变成笑话、新人永远追不上老人、积分不再代表任何东西。
  // 调这些数之前先看 /admin/points 的通胀体检。
  {
    key: "points.economy.daily_mint_cap",
    value: "60",
    type: "int",
    category: "points",
    label: "每人每日发行上限",
    description:
      "所有来源共享这一个预算：打卡、高质量加分、连胜、互动结算都从这里出。各来源各自封顶的话，每加一个玩法就等于给通胀开一个新口子",
    min: 0,
    max: 10_000,
  },
  {
    key: "points.economy.inflation_warn_percent",
    value: "8",
    type: "int",
    category: "points",
    label: "月净增占流通量的告警比例（%）",
    description: "超过这个值后台会标红。看比例不看绝对值 —— 社区变大发行自然变多，那不是通胀",
    min: 1,
    max: 100,
  },
  {
    key: "points.interaction.full_units",
    value: "10",
    type: "int",
    category: "points",
    label: "互动结算全额段的单位数",
    description: "前多少个加权单位按全额计分，超出部分打折",
    min: 0,
    max: 1000,
  },
  {
    key: "points.interaction.decay_percent",
    value: "50",
    type: "int",
    category: "points",
    label: "互动结算超出部分的折算比例（%）",
    description: "两段式递减而不是几何衰减 —— 后者更平滑但没法用一句话跟用户讲清楚",
    min: 0,
    max: 100,
  },
  {
    key: "points.interaction.points_per_unit",
    value: "1",
    type: "int",
    category: "points",
    label: "每单位互动折算的积分",
    min: 0,
    max: 100,
  },
  {
    key: "points.interaction.daily_cap",
    value: "20",
    type: "int",
    category: "points",
    label: "互动结算每日上限",
    min: 0,
    max: 1000,
  },
  {
    key: "points.transfer.fee_percent",
    value: "5",
    type: "int",
    category: "points",
    label: "转赠手续费比例（%）",
    description: "直接销毁，不进任何人的口袋 —— 进了就不是回收了",
    min: 0,
    max: 50,
  },
  {
    key: "points.makeup_card.cost",
    value: "200",
    type: "int",
    category: "points",
    label: "补签卡消耗积分",
  },
  {
    key: "points.makeup_card.monthly_limit",
    value: "1",
    type: "int",
    category: "points",
    label: "每月补签次数上限",
  },
  {
    key: "points.large_adjust_threshold",
    value: "500",
    type: "int",
    category: "points",
    // 它挡的是权限（points.adjust.large），不是复核 —— 旧标签一直写错了
    label: "需要更高权限的积分调整额度",
  },

  // ── 反作弊 ──────────────────────────────────────────────────
  {
    key: "antifraud.same_minute_collapse",
    value: "true",
    type: "bool",
    category: "antifraud",
    label: "同一分钟内多条按 1 条计",
  },
  {
    key: "antifraud.dedupe_similar",
    value: "true",
    type: "bool",
    category: "antifraud",
    label: "重复或近似内容不计分",
  },
  {
    key: "antifraud.spike_threshold",
    value: "3",
    type: "int",
    category: "antifraud",
    label: "日增为均值多少倍时进风控队列",
  },

  // ── 存储（磁盘有限，这几项是硬约束）────────────────────────
  {
    key: "storage.hot_days",
    value: "90",
    type: "int",
    category: "storage",
    label: "热层保留天数（全量正文 + 全量索引）",
  },
  {
    key: "storage.warm_days",
    value: "365",
    type: "int",
    category: "storage",
    label: "温层保留天数（全量正文，仅索引高质量消息）",
  },
  {
    key: "storage.cold_keep_quality_only",
    value: "true",
    type: "bool",
    category: "storage",
    label: "冷层只保留高质量消息",
    description:
      "设计上「本地是缓存、需要时回源」，但上游自己也只有约两个月历史 —— " +
      "这个前提今天还证明不了。所以丢正文之前必须先归档，见下一项",
  },
  {
    key: "storage.archive_before_drop",
    value: "true",
    type: "bool",
    category: "storage",
    label: "丢弃正文前先归档成文件",
    description:
      "关掉就是直接删除，且不可逆。关掉时裁剪会先抽样验证上游确实回得来，" +
      "验不过就整步跳过 —— 磁盘占着总比记录没了强",
  },
  {
    key: "auth.session.max_per_user",
    value: "10",
    type: "int",
    category: "auth",
    label: "一个人最多同时登录几台设备",
    description: "超出时自动下线最久没用的那几台。不设上限的后果不是更安全，是「登录设备」那一页变成一串认不出来的条目",
    min: 2,
    max: 50,
  },
  {
    key: "auth.session.revoked_keep_days",
    value: "30",
    type: "int",
    category: "auth",
    label: "已下线会话保留天数",
    description: "留一段时间是为了「这台什么时候被谁下线的」还答得上来；每一行都带着 IP 和 UA，留着不看等于白留一份可泄露的东西",
    min: 1,
    max: 365,
  },
  {
    key: "upstream.usage_retention_days",
    value: "30",
    type: "int",
    category: "storage",
    label: "上游调用流水保留天数",
    description: "同步每几分钟一次，这张表长得最快；而它的价值窗口很短 —— 要看的是最近有没有在报错",
    min: 1,
    max: 365,
  },
  {
    key: "storage.media_cache_max_bytes",
    value: "2147483648",
    type: "int",
    category: "storage",
    label: "媒体 LRU 缓存上限（字节）",
    description:
      "**卡在上游**：/v1/messages 不返回任何媒体地址，库里 2998 条图片消息的正文就是「[图片]」三个字 —— 没有可缓存的东西。等上游透传媒体 URL 之后才谈得上缓存",
    status: "planned",
  },
  {
    key: "storage.thumb_max_edge",
    value: "320",
    type: "int",
    category: "storage",
    label: "缩略图长边像素",
    description: "同上，卡在上游没有媒体地址",
    status: "planned",
  },
  {
    key: "storage.disk_warn_pct",
    value: "70",
    type: "int",
    category: "storage",
    label: "磁盘告警水位（%）",
  },
  {
    key: "storage.disk_prune_pct",
    value: "85",
    type: "int",
    category: "storage",
    label: "自动触发裁剪水位（%）",
  },
  {
    key: "storage.disk_stop_cache_pct",
    value: "92",
    type: "int",
    category: "storage",
    label: "停止媒体缓存写入水位（%）",
  },

  // ── 模块启停（真正的判定见 src/lib/modules/state.ts）──────────
  {
    key: "module.sync.enabled",
    value: "true",
    type: "bool",
    category: "module",
    label: "模块：消息同步",
    description: "关掉之后不再拉新消息 —— 排行榜、签到、搜索、资源库、雷达全部停在当前这一刻",
  },
  {
    key: "module.links.enabled",
    value: "true",
    type: "bool",
    category: "module",
    label: "模块：链接资源库",
    description: "关掉之后新消息不再抽链接；已收录的照常可见",
  },
  {
    key: "module.radar.enabled",
    value: "true",
    type: "bool",
    category: "module",
    label: "模块：关键词雷达",
    description: "关掉之后不再扫描与通知；已有订阅与命中记录保留",
  },
  {
    key: "module.directory.enabled",
    value: "true",
    type: "bool",
    category: "module",
    label: "模块：成员目录",
    description: "关掉之后 /members 显示为已关闭；标签数据保留",
  },
  {
    key: "module.shop.enabled",
    value: "true",
    type: "bool",
    category: "module",
    label: "模块：积分商店",
    description: "关掉之后不能再下单，积分会变成只进不出",
  },
  {
    key: "module.broadcast.enabled",
    value: "true",
    type: "bool",
    category: "module",
    label: "模块：群发",
    description: "关掉之后一律不向微信群发送，包括已排好的",
  },
  {
    key: "module.offsite.enabled",
    value: "true",
    type: "bool",
    category: "module",
    label: "模块：异地备份",
    description: "关掉之后不再上传 —— 备份只存在服务器这一块磁盘上",
  },
  {
    key: "module.prune.enabled",
    value: "true",
    type: "bool",
    category: "module",
    label: "模块：存储自动裁剪",
    description: "关掉之后磁盘满了要人工处理",
  },
  {
    key: "module.alerts.enabled",
    value: "true",
    type: "bool",
    category: "module",
    label: "模块：告警投递",
    description: "关掉之后告警仍然落库但不再发出去",
  },

  // ── 上游同步 ────────────────────────────────────────────────
  {
    key: "sync.quality_min",
    value: "15",
    type: "int",
    category: "sync",
    label: "高质量消息字数阈值",
    description: "与上游默认一致。改动会影响全部历史统计，需重算",
  },
  {
    key: "sync.messages.interval_seconds",
    value: "60",
    type: "int",
    category: "sync",
    label: "消息增量同步间隔（秒）",
    min: 15,
    max: 3600,
  },
  {
    key: "sync.bind_poll.interval_seconds",
    value: "3",
    type: "int",
    category: "sync",
    label: "绑定验证轮询间隔（秒）",
    description: "只在有待验证的码时才轮询",
    min: 1,
    max: 30,
  },

  // ── 每周精选回推 ────────────────────────────────────────────
  {
    key: "module.digest.enabled",
    /*
     * 默认开着，和其它模块一致（「默认关掉的功能等于没做」）。
     *
     * 它以前默认是关的 —— 那份谨慎是冲着**发送**去的，
     * 而发送这一步这个模块根本不做：它只把草稿备好，
     * 发不发、发给谁，全部走群发那一整套双人复核。
     * 谨慎放在该放的地方，这一步就不必再关着了。
     */
    value: "true",
    type: "bool",
    category: "digest",
    label: "模块：每周精选",
    description: "关掉后不再挑稿、不再备草稿。它只备草稿 —— 发送始终走群发那一套复核流程",
  },
  { key: "digest.top_n", value: "5", type: "int", category: "digest", label: "每期推送帖子数" },
  {
    key: "digest.max_per_author",
    value: "2",
    type: "int",
    category: "digest",
    label: "同一作者最多入选篇数",
  },

  // ── 论坛 ────────────────────────────────────────────────────
  {
    key: "forum.newbie_no_link_days",
    value: "3",
    type: "int",
    category: "forum",
    label: "新人多少天内发外链会被降权",
    description:
      "不再直接拦下来：内容照发，链接拆成 example[.]com 这样点不动的形式，并告诉他满几天之后就不会这样了。" +
      "拦截只教会人「这里不让说话」，被拦一次多半就不发第二次了。设 0 关闭",
    min: 0,
    max: 90,
  },
  {
    key: "forum.rate_window_seconds",
    value: "600",
    type: "int",
    category: "forum",
    label: "发帖回帖频率统计窗口（秒）",
    min: 60,
    max: 86400,
  },
  {
    key: "forum.max_posts_per_window",
    value: "3",
    type: "int",
    category: "forum",
    label: "窗口内最多发帖数",
    min: 1,
    max: 100,
  },
  {
    key: "forum.max_replies_per_window",
    value: "15",
    type: "int",
    category: "forum",
    label: "窗口内最多回帖数",
    min: 1,
    max: 500,
  },
  {
    key: "forum.collapse_threshold",
    value: "-3",
    type: "int",
    category: "forum",
    label: "回复被折叠的净反应阈值",
    status: "planned",
  },

  // ── 站点 ────────────────────────────────────────────────────
  {
    key: "site.registration_open",
    value: "true",
    type: "bool",
    category: "site",
    label: "开放绑定注册",
  },
  {
    key: "site.forum_public",
    value: "true",
    type: "bool",
    category: "site",
    label: "论坛允许未登录浏览",
  },
];

/** 功能开关：出问题时先关模块，而不是回滚整站 */
/**
 * 种子里的开关初值。
 *
 * `keyword_radar` 和 `shop` 原来写着 false，而那两个页面一直是活的、
 * 也一直挂在导航里 —— **库里的值是陈旧的，不是真相**。
 * 接线那一刻如果照着它来，两个在用的功能会当场消失。
 *
 * 真正的清单在 lib/flags/registry.ts；这里只管新库的初值。
 */
export const DEFAULT_FLAGS: readonly {
  key: string;
  enabled: boolean;
  description: string;
}[] = [
  { key: "external_users", enabled: false, description: "允许非群成员注册（现阶段关闭）" },
  { key: "forum", enabled: true, description: "论坛" },
  { key: "message_search", enabled: true, description: "群消息检索" },
  { key: "link_library", enabled: true, description: "链接资源库" },
  { key: "keyword_radar", enabled: true, description: "关键词雷达订阅" },
  { key: "shop", enabled: true, description: "积分商店" },
  { key: "events", enabled: true, description: "活动系统" },
  { key: "temp_mailbox", enabled: false, description: "临时邮箱" },
  { key: "rag_qa", enabled: false, description: "群聊 RAG 问答" },
];
