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
}

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
    key: "points.streak.cap",
    value: "30",
    type: "int",
    category: "points",
    label: "连胜奖励上限",
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
    label: "触发双人复核的积分调整额度",
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
    description: "上游 NekoBot 才是数据源，本地是缓存，冷数据可放心裁剪、需要时回源",
  },
  {
    key: "storage.media_cache_max_bytes",
    value: "2147483648",
    type: "int",
    category: "storage",
    label: "媒体 LRU 缓存上限（字节）",
    description: "原图永不长期落盘。默认 2GB",
  },
  {
    key: "storage.thumb_max_edge",
    value: "320",
    type: "int",
    category: "storage",
    label: "缩略图长边像素",
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
    key: "digest.enabled",
    value: "false",
    type: "bool",
    category: "digest",
    label: "启用每周精选回推",
  },
  {
    key: "digest.auto_send",
    value: "false",
    type: "bool",
    category: "digest",
    label: "自动发送（关闭则生成草稿等管理员确认）",
    description: "默认半自动。自动发到 12 个真实微信群，出一次错就是社死现场",
  },
  { key: "digest.top_n", value: "5", type: "int", category: "digest", label: "每期推送帖子数" },
  {
    key: "digest.max_per_author",
    value: "2",
    type: "int",
    category: "digest",
    label: "同一作者最多入选篇数",
  },
  {
    key: "digest.per_group_weekly_limit",
    value: "1",
    type: "int",
    category: "digest",
    label: "每群每周推送次数硬上限",
  },

  // ── 站点 ────────────────────────────────────────────────────
  { key: "site.name", value: "Agentic Lab", type: "string", category: "site", label: "站点名称" },
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
export const DEFAULT_FLAGS: readonly {
  key: string;
  enabled: boolean;
  description: string;
}[] = [
  { key: "external_users", enabled: false, description: "允许非群成员注册（现阶段关闭）" },
  { key: "forum", enabled: true, description: "论坛" },
  { key: "message_search", enabled: true, description: "群消息检索" },
  { key: "link_library", enabled: true, description: "链接资源库" },
  { key: "keyword_radar", enabled: false, description: "关键词雷达订阅" },
  { key: "shop", enabled: false, description: "积分商店" },
  { key: "events", enabled: true, description: "活动系统" },
  { key: "temp_mailbox", enabled: false, description: "临时邮箱" },
  { key: "rag_qa", enabled: false, description: "群聊 RAG 问答" },
  { key: "weekly_digest", enabled: false, description: "每周精选回推微信群" },
];
