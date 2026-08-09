# 数据模型与后台设计

目标：**后台不是"加个 admin 页面"，是完整的第二套产品。**
每一个后台功能都必须有完整落盘 —— 谁做的、什么时候、改了什么、改前是什么、为什么改。

---

# 零、全局约定

这些约定贯穿所有表，先定死，后面不再重复说明。

| 约定 | 做法 | 为什么 |
|---|---|---|
| 主键 | `id TEXT` 用 ULID | 单调递增可排序、分布式无冲突、不暴露数量 |
| 时间 | `INTEGER` 毫秒时间戳 | 与上游 `last_time` 格式一致，省转换 |
| 软删除 | `deleted_at`, `deleted_by`, `delete_reason` | 后台任何删除都可恢复、可追责 |
| 操作人 | `created_by`, `updated_by` | 所有可被后台修改的表都要有 |
| 状态 | `status TEXT` 显式枚举，不用散落的布尔 | 状态机可穷举、可校验、可迁移 |
| 扩展 | `meta TEXT`（JSON） | 预留字段，避免每次加需求都改表 |
| 幂等 | 外部触发的写操作带 `idempotency_key` | 重试不会重复发积分/重复发消息 |

**三条不可妥协的规则**

1. **一切可配**：任何数值（积分、阈值、天数、限流）都进 `settings`，不写进代码。
2. **一切留痕**：任何后台写操作都进 `audit_logs`，含变更前后快照。
3. **一切可回滚**：配置有版本历史，删除是软删，积分调整有反向流水。

---

# 一、身份与账号

### `users` — 账号主体
```
id                TEXT PK
wx_id             TEXT UNIQUE NULL      -- 绑定后填入；external 用户为 NULL
wx_nickname       TEXT                  -- 上游同步，不可编辑
wx_avatar_url     TEXT                  -- 本地缩略图路径
site_nickname     TEXT                  -- 用户自设，覆盖显示
bio               TEXT
email             TEXT UNIQUE NULL
email_verified_at INTEGER NULL
kind              TEXT   -- member | external | bot | system
status            TEXT   -- pending | active | suspended | banned | left | deleted
level             INTEGER DEFAULT 1
points            INTEGER DEFAULT 0     -- 冗余缓存，真值由 points_ledger 求和
points_total      INTEGER DEFAULT 0     -- 累计获得（不减），用于等级计算
streak_current    INTEGER DEFAULT 0
streak_best       INTEGER DEFAULT 0
last_checkin_date TEXT NULL             -- YYYY-MM-DD
invited_by        TEXT NULL FK users.id
first_bound_at    INTEGER NULL
last_active_at    INTEGER NULL
created_at / updated_at / deleted_at / deleted_by / delete_reason
meta              TEXT
```
> `points` 是缓存列。后台提供「重算」按钮，从 `points_ledger` 重新求和比对，
> 不一致时告警 —— 这是发现积分 bug 或作弊的第一道网。

### `user_identities` — 外部身份（预留多平台）
```
id, user_id FK, provider(wechat|github|google|...), external_id,
display_name, avatar_url, raw TEXT, linked_at, unlinked_at
UNIQUE(provider, external_id)
```
> 现在只有 wechat。预留这张表，将来接 GitHub 登录不用动 `users`。

### `credentials` — 登录凭证
```
id, user_id FK, type(passkey|password|email_magic|totp),
name TEXT,                 -- "我的 iPhone"，用户可命名
public_key / hash TEXT,    -- passkey 公钥 或 argon2id 哈希
counter INTEGER,           -- WebAuthn 签名计数器，防克隆
transports TEXT,
last_used_at, last_used_ip,
created_at, revoked_at, revoked_by, revoke_reason
```

### `sessions` — 会话与设备
```
id, user_id FK, refresh_token_hash, device_name, device_fingerprint,
ip, user_agent, geo TEXT,
created_at, last_seen_at, expires_at,
revoked_at, revoked_by, revoke_reason(logout|admin|password_change|expired)
```
> 后台可查任意用户的活跃会话并远程下线，操作进审计日志。

### `login_attempts` — 登录审计（成功失败都记）
```
id, user_id NULL, identifier, method, success INTEGER,
failure_reason, ip, user_agent, created_at
```
> 用于限流、异常登录告警、用户自己的「登录历史」页。

### `bind_codes` — 绑定验证码
```
id, code TEXT, user_id NULL, channel(friend_request|direct_message),
status(pending|used|expired|revoked),
issued_ip, matched_wx_id NULL, matched_source TEXT,  -- 命中的申请理由或私聊原文
created_at, expires_at, used_at, attempts INTEGER
```
> 保留 `matched_source` 原文 —— 绑定纠纷时这是唯一证据。

### `user_privacy` — 隐私开关
```
user_id PK, hide_from_directory, hide_from_leaderboard,
hide_activity_hours, allow_dm, searchable_by_others, updated_at
```

### `user_notes` — 管理员备注（用户不可见）
```
id, user_id FK, author_id FK, content, pinned, created_at, deleted_at
```
> 后台给用户打备注：「此人多次刷屏，已口头警告」。运营连续性靠这个。

---

# 二、身份组与权限（预留可扩展）

不要写 `if (role === 'admin')`。权限点粒度化，角色是权限点的集合，且**角色本身可在后台自定义**。

### `permissions` — 权限点字典（代码定义，启动时同步入库）
```
key TEXT PK           -- 'forum.post.delete' / 'user.points.adjust' / 'group.messages.read'
category TEXT         -- user | forum | points | event | shop | system | group
label, description
scopable INTEGER      -- 是否支持范围限定（如限定某版块/某群）
danger_level INTEGER  -- 0 普通 / 1 敏感 / 2 危险（需二次验证）/ 3 极危（需双人复核）
```

### `roles` — 身份组（**可后台自建**）
```
id, key TEXT UNIQUE, name, description,
color TEXT, icon TEXT, badge_style TEXT,   -- 身份组在前台的视觉标识
priority INTEGER,                          -- 多身份组时的显示优先级
is_system INTEGER,                         -- 内置角色不可删（owner/member 等）
assignable INTEGER,                        -- 是否可手动授予
max_holders INTEGER NULL,                  -- 名额上限（如"版主限 5 人"）
auto_grant_rule TEXT NULL,                 -- JSON：自动授予条件（如 level>=8）
created_at/updated_at/created_by/deleted_at
```
> **这就是"预留身份组"**：内置 owner/admin/moderator/group_admin/auditor/member/external/banned，
> 但结构上支持无限自定义 —— 将来要加「讲师」「赞助商」「元老」「实习管理员」，
> 后台建一个角色、勾选权限点即可，不改代码。
> `color`/`icon`/`badge_style` 让身份组在前台成为荣誉标识，而不只是权限容器。

### `role_permissions`
```
role_id, permission_key, granted INTEGER   -- granted=0 表示显式拒绝（优先级高于允许）
PK(role_id, permission_key)
```

### `user_roles` — 授予记录（带范围与期限）
```
id, user_id, role_id,
scope_type TEXT NULL,   -- null(全站) | board | group | event
scope_id   TEXT NULL,   -- 版块 id / conv_id / 活动 id
granted_by, granted_at, grant_reason,
expires_at NULL,        -- 临时授权，到期自动收回
revoked_at, revoked_by, revoke_reason
```
> **范围化授权**是关键：某人是"#1 群的群管理员"、"技术版的版主"，而不是全站管理员。
> `expires_at` 支持临时提权（活动期间给某人临时权限），到期自动回收并记日志。

### `permission_overrides` — 用户级例外
```
id, user_id, permission_key, granted, scope_type, scope_id,
reason, granted_by, granted_at, expires_at
```
> 偶尔需要给单个用户开一个口子，不值得为此建角色。

### 内置身份组预设

| key | 名称 | 范围 | 说明 |
|---|---|---|---|
| `owner` | 站长 | 全站 | 一切；唯一可授予 admin；唯一可改系统设置 |
| `admin` | 管理员 | 全站 | 用户/内容/活动/积分/公告；不可改 owner、不可改系统设置 |
| `moderator` | 版主 | 版块 | 该版块内容审核 |
| `group_admin` | 群管理 | 群 | 该群成员、榜单、群公告 |
| `auditor` | 审计员 | 全站 | **只读**，含审计日志；零写权限 |
| `member` | 成员 | 自己 | 普通用户 |
| `external` | 外部用户 | 受限 | 无群消息访问权 |
| `banned` | 封禁 | — | 禁止登录 |

---

# 三、邀请体系

### `invite_codes`
```
id, code TEXT UNIQUE, created_by,
kind(member|external|event|admin),      -- 邀请后自动授予的身份类型
grant_role_id NULL,                     -- 邀请后自动授予的身份组
max_uses INTEGER, used_count INTEGER,
expires_at NULL,
note TEXT,                              -- "给厦大社区那批人"
status(active|exhausted|expired|revoked),
revoked_at, revoked_by, revoke_reason,
created_at
```

### `invites` — 使用记录（构成邀请树）
```
id, code_id FK, inviter_id, invitee_id,
used_at, used_ip,
reward_points INTEGER, reward_settled_at NULL,
status(pending|completed|reverted)      -- 被邀请人被封时可 revert 并回收奖励
```
> 邀请树 = `users.invited_by` 自引用 + 这张明细表。
> 后台可查任意成员的上游引荐人与下游全部分支 —— 出问题时能追到源头，
> 也是将来开放 external 注册时的风控基础。

---

# 四、上游数据镜像

### `groups`
```
conv_id TEXT PK, name, avatar_url,
is_group, bound,
sync_enabled INTEGER,          -- 是否纳入本站
quality_min INTEGER NULL,      -- 覆盖全局默认值
count_for_points INTEGER,      -- 是否计入积分
public_leaderboard INTEGER,    -- 榜单是否公开
retention_days INTEGER NULL,   -- 覆盖全局保留策略
description, notice,
member_count, message_count, last_message_at,
created_at/updated_at/updated_by
```

### `group_members` + `group_member_events`
```
group_members:  conv_id, wx_id, display_name, joined_at, left_at, is_admin
                PK(conv_id, wx_id)
group_member_events: id, conv_id, wx_id, event(join|leave|rename|promote),
                     detail TEXT, detected_at
```
> 每日同步比对产生 events。**退群要自动收回该群消息可见权** —— 这条逻辑靠 events 驱动。

### `messages` — 本地镜像（分层保留，见 PLAN.md §7.3）
```
id TEXT PK, upstream_id, conv_id, sender_wx_id, sender_name,
content TEXT, msg_type, length INTEGER, is_quality INTEGER,
quoted_msg_id NULL, mentions TEXT,
has_media INTEGER, ts INTEGER,
tier(hot|warm|cold), indexed INTEGER, synced_at
```
+ `messages_fts` (FTS5 虚拟表，按 tier 决定是否入索引)

### `message_media` — 只存元信息，不存原图
```
id, message_id, kind(image|file|voice|video), upstream_ref,
mime, size, width, height, duration,
thumb_path NULL,        -- 唯一持久化的东西：webp 缩略图 ≤320px
cached_path NULL, cached_at, cache_hits, last_access_at
```
> `cached_path` 走 LRU，硬上限 2GB，超限淘汰。原图永不长期落盘。

### `daily_stats` — 聚合，冷层唯一保留的统计
```
wx_id, conv_id, date TEXT, messages, quality_messages,
chars_total, first_msg_at, last_msg_at, hour_histogram TEXT
PK(wx_id, conv_id, date)
```

### `sync_jobs` / `sync_cursors` — 同步任务全落盘
```
sync_jobs:    id, kind(messages|members|avatars|friend_requests|leaderboard),
              scope, status(pending|running|success|failed|partial),
              started_at, finished_at, duration_ms,
              items_fetched, items_written, error TEXT, retry_count,
              triggered_by(cron|admin|api), triggered_by_user NULL
sync_cursors: kind, scope, last_ts, last_id, updated_at
```
> **后台必须能看到每一次同步的结果**：拉了多少、写了多少、失败原因、重试了几次。
> 数据不对时，第一时间看这张表，而不是猜。

---

# 五、积分 · 等级 · 成就

### `point_rules` — 规则配置（后台可改，改动有历史）
```
id, key TEXT UNIQUE,           -- 'checkin' / 'quality_bonus' / 'streak' / 'post_featured'
name, description,
points INTEGER, formula TEXT NULL,   -- 复杂规则用表达式
daily_cap INTEGER NULL, total_cap INTEGER NULL,
cooldown_seconds INTEGER NULL,
enabled INTEGER, sort INTEGER,
updated_at, updated_by
```

### `points_ledger` — 唯一真值，只增不改
```
id, user_id, delta INTEGER, balance_after INTEGER,
rule_key NULL, reason TEXT NOT NULL,
ref_type(checkin|post|reply|event|redeem|invite|admin|revert), ref_id,
operator_id NULL,              -- 管理员手动调整时必填
reverted_by NULL, reverts_id NULL,   -- 冲正：用反向流水，绝不改原记录
idempotency_key UNIQUE NULL,
created_at
```
> **`reason` 非空是硬约束**。管理员手动调分必须写理由，写不出理由的调整不该发生。

### `checkins`
```
id, user_id, date TEXT, points_awarded,
quality_msgs_that_day INTEGER, streak_after INTEGER,
is_makeup INTEGER, makeup_cost INTEGER,   -- 补签卡
ip, created_at
UNIQUE(user_id, date)
```

### `levels` — 等级配置
```
level PK, name, points_required, icon, color,
perks TEXT   -- JSON：解锁的权限点/功能开关
```

### `badges` / `user_badges`
```
badges:      id, key, name, description, icon, rarity,
             criteria TEXT,       -- JSON 判定条件
             auto_grant INTEGER, enabled, sort, created_by
user_badges: id, user_id, badge_id, granted_at,
             granted_by NULL, grant_reason,   -- 手动授予时填
             revoked_at, revoked_by, revoke_reason, featured INTEGER
```

### `points_anomalies` — 风控队列
```
id, user_id, kind(spike|duplicate|velocity|manual_flag),
detail TEXT, score, status(open|cleared|confirmed),
reviewed_by, reviewed_at, resolution TEXT, created_at
```
> 积分异常增长自动进队列，后台人工复核。没有这个，积分体系一周就废。

---

# 六、论坛 · 问答

```
boards         id, key, name, description, icon, sort, parent_id NULL,
               visibility(public|member|role), required_role_id NULL,
               post_min_level, allow_anonymous, locked,
               post_count, last_post_at, created_by, deleted_at

posts          id, board_id, author_id, title, content, content_html,
               type(discussion|question|showcase|announcement),
               status(draft|published|locked|hidden|deleted),
               pinned, pinned_until, featured, featured_by, featured_at,
               view_count, reply_count, reaction_count, last_reply_at,
               source_type NULL, source_ref NULL,   -- ★ 群聊成帖的来源
               created_at/updated_at/deleted_at/deleted_by/delete_reason

post_sources   id, post_id, conv_id, message_ids TEXT,
               converted_by, converted_at, consent_status
               -- ★ 群聊一键成帖：留存原始消息 id 与授权状态

replies        id, post_id, parent_id NULL, author_id, content,
               status, accepted INTEGER,        -- 问答最佳答案
               reaction_count, created_at/deleted_at/deleted_by/delete_reason

reactions      id, target_type(post|reply|link), target_id, user_id,
               kind(like|useful|star), created_at   UNIQUE(target,user,kind)

bookmarks      id, user_id, target_type, target_id, folder, created_at

bounties       id, post_id, user_id, points, status(open|awarded|refunded|expired),
               awarded_reply_id, awarded_at, expires_at, created_at
```

---

# 七、资源库 · 活动 · 商店

```
links          id, url, url_hash UNIQUE, title, description, favicon, site,
               first_seen_conv_id, first_seen_message_id, first_seen_by, first_seen_at,
               mention_count, click_count, status(active|dead|blocked),
               fetched_at, fetch_error, tags TEXT, curated_by NULL

events         id, title, cover, description, type(online|offline|hybrid),
               location, url, starts_at, ends_at,
               capacity, waitlist_enabled,
               require_level, require_points, require_role_id, require_group NULL,
               signup_opens_at, signup_closes_at,
               checkin_code, checkin_points,
               status(draft|published|ongoing|ended|cancelled),
               created_by/updated_by/cancelled_by/cancel_reason

event_signups  id, event_id, user_id, status(signed|waitlist|cancelled|attended|noshow),
               form_data TEXT, signed_at, cancelled_at, position INTEGER
event_checkins id, event_id, user_id, method(code|admin|qr),
               operator_id, points_awarded, checked_at, ip

shop_items     id, name, description, image, category,
               price_points, stock INTEGER NULL, per_user_limit,
               requires_level, requires_role_id,
               kind(virtual|physical|privilege), payload TEXT,
               status(draft|listed|sold_out|delisted),
               created_by/updated_by/delisted_by

redemptions    id, user_id, item_id, price_points, quantity,
               status(pending|approved|rejected|shipped|completed|refunded),
               ledger_id,                       -- 关联扣分流水，退款时冲正
               shipping_info TEXT, tracking_no,
               operator_id, note, created_at
order_events   id, redemption_id, from_status, to_status,
               operator_id, note, created_at    -- 订单状态流转全程留痕
```

---

# 八、通知 · 订阅

```
subscriptions      id, user_id, kind(keyword|user|board|group|post),
                   value, scope TEXT, enabled, created_at
                   -- 关键词雷达
notifications      id, user_id, type, title, body, link,
                   ref_type, ref_id, read_at, created_at
notification_prefs user_id PK, 各类型 × 各渠道(site|email) 的开关 JSON, updated_at
email_log          id, user_id, to_email, template, subject,
                   status(queued|sent|failed|bounced), provider_id,
                   error, sent_at, opened_at
                   -- 每一封发出去的邮件都要留底
```

---

# 九、审核 · 治理

```
reports            id, reporter_id, target_type(post|reply|user|link|message),
                   target_id, reason_code, detail,
                   status(open|reviewing|resolved|rejected|duplicate),
                   severity, assigned_to, resolved_by, resolved_at,
                   resolution TEXT, created_at

moderation_actions id, actor_id, target_type, target_id, target_user_id,
                   action(warn|hide|delete|lock|pin|feature|move|mute|suspend|ban|unban),
                   reason TEXT NOT NULL, detail,
                   duration_seconds NULL, expires_at NULL,
                   report_id NULL, reverted_by NULL, reverted_at,
                   created_at
                   -- ★ 所有处罚都在这一张表，用户档案页直接聚合展示历史

sensitive_words    id, word, kind(block|review|replace), replacement,
                   scope, enabled, hit_count, created_by, created_at
moderation_queue   id, target_type, target_id, trigger(word|report|anomaly|new_user),
                   status, assigned_to, created_at

appeals            id, user_id, action_id, content,
                   status(open|accepted|rejected), handled_by, handled_at,
                   response TEXT, created_at
                   -- 有处罚就必须有申诉通道，否则管理只会积累怨气
```

---

# 十、后台基建（最关键的部分）

### `audit_logs` — 只增不改不删
```
id, actor_id, actor_role, actor_ip, actor_ua,
action TEXT,           -- 'user.role.grant' / 'settings.update' / 'points.adjust'
target_type, target_id, target_label,
before TEXT,           -- JSON 快照
after  TEXT,           -- JSON 快照
reason TEXT,
danger_level, approval_id NULL,
request_id, created_at
```
> **每一个后台写操作都必须写这张表**，没有例外。
> `auditor` 角色可读全表。此表不提供任何删除接口。
>
> **实现方式（2026-08 定稿，与原设计不同）**：原计划是「在数据访问层做统一拦截」。
> 实际做不出来 —— drizzle 的写入没有统一入口，硬套一层代理只会得到一堆
> 「谁在写」说不清楚的记录，而说不清楚是谁写的审计日志比没有更糟：
> 它会让人以为查过了。
>
> 改成**静态检查**：`src/lib/audit/coverage.ts` 扫源码，
> 凡是调了 `requireAdmin` 又做了写操作的导出函数，
> 必须调 `audit()`／`audited()`，或委托给一个自己会记账的模块，
> 由 `tests/audit-coverage.test.ts` 每次 `npm test` 强制。
> 它抓不到「记了但记错了」，只抓「压根没记」—— 而后者占绝大多数。
> 上线当天就查出 5 处漏记（其中 3 处是修好检查器自身的 bug 之后才暴露的）。

### `settings` + `setting_history` — 一切可配 + 可回滚
```
settings         key TEXT PK, value TEXT, type(string|int|bool|json),
                 category, label, description,
                 default_value, min/max, requires_role,
                 updated_at, updated_by
setting_history  id, key, old_value, new_value, changed_by, reason, created_at
```
> 积分数值、`quality_min`、保留天数、限流阈值、磁盘水位线、邮件模板……全在这。
> 后台改配置 = 写 `settings` + 写 `setting_history` + 写 `audit_logs`，三处齐全才算完成。

### `feature_flags` — 模块开关
```
key PK, enabled, rollout(all|role|user|percent), rollout_value,
description, updated_at, updated_by
```
> external 用户、商店、活动、RAG 问答、关键词雷达 —— 每个模块独立开关。
> 出问题时先关模块，而不是回滚整站。

### `approvals` — 危险操作双人复核
```
id, action TEXT, payload TEXT, danger_level,
requested_by, requested_at, reason,
status(pending|approved|rejected|expired|executed),
approved_by, approved_at, approve_note,
executed_at, execute_result, expires_at
```
> `danger_level >= 3` 的操作（批量删除、大额积分、全群广播、改 owner）
> 不直接执行，先落一条待批记录，需另一名管理员批准。**这是防止管理员误操作和内鬼的唯一手段。**

### `announcements` + `broadcasts` — 公告与群发
```
announcements  id, title, content, style(banner|modal|inbox),
               audience_type(all|role|group|level|user_list), audience_value,
               starts_at, ends_at, dismissible,
               status(draft|scheduled|published|ended|withdrawn),
               view_count, created_by/published_by/withdrawn_by

broadcasts     id, channel(wechat|email|site), target_convs TEXT,
               content, preview_snapshot,
               status(draft|pending_approval|approved|sending|sent|failed|cancelled),
               approval_id,                  -- 强制走双人复核
               requested_by, approved_by, sent_at,
               sent_count, failed_count, upstream_response TEXT,
               created_at
```
> 微信群发走 `POST /send/text`，仅 owner/admin，**强制二次确认 + 预览快照 +
> 双人复核 + 每群每日频率上限**，发送结果与上游响应全部落盘，可与 `/send/history` 对账。

### `admin_tasks` — 后台发起的长任务
```
id, kind(recount_points|reindex_fts|prune_storage|resync_group|export_data|bulk_action),
params TEXT, status(queued|running|success|failed|cancelled),
progress INTEGER, total INTEGER,
preview TEXT,            -- 执行前的影响预估，如"将释放 820 MB / 影响 3,412 条"
result TEXT, error TEXT,
created_by, started_at, finished_at
```
> **危险批量操作必须先出 preview，再执行。** 后台点「裁剪存储」之前要能看到会删掉什么。

### `system_health` / `storage_snapshots` — 运维可见
```
system_health     id, component(upstream_api|frp_tunnel|db|disk|mail|cron),
                  status(ok|degraded|down), detail, latency_ms, checked_at
storage_snapshots id, taken_at, db_bytes, fts_bytes, media_cache_bytes,
                  thumb_bytes, log_bytes, disk_total, disk_used, disk_pct,
                  by_table TEXT
```
> frp 隧道是单点，必须持续探测并告警。磁盘水位趋势图放在后台首屏。

### `api_usage` — 上游调用统计
```
id, endpoint, method, status_code, latency_ms,
triggered_by, error, created_at
```
> 上游有配额（`/whoami` 的 `calls`、`/send/quota`）。调用量要能看、能定位是谁打的。

---

# 十一、后台功能 ↔ 落盘对照表

**验收标准：下表每一行的"落盘"列必须真实存在，否则该功能不算做完。**

| 后台功能 | 落盘 |
|---|---|
| 调整用户积分 | `points_ledger`(含 reason+operator) + `audit_logs` |
| 封禁 / 解封 | `users.status` + `moderation_actions` + `sessions` 全撤销 + `audit_logs` + 通知用户 |
| 授予 / 撤销身份组 | `user_roles`(含 reason/expires) + `audit_logs` |
| 新建自定义身份组 | `roles` + `role_permissions` + `audit_logs` |
| 通过好友申请绑定 | `bind_codes`(含 matched_source) + `users` + `user_identities` + `audit_logs` |
| 生成邀请码 | `invite_codes` + `audit_logs`；使用时 `invites` + 奖励 `points_ledger` |
| 删除帖子 / 回复 | 软删字段 + `moderation_actions`(含 reason) + `audit_logs` + 通知作者 |
| 加精 / 置顶 | `posts` 字段 + 操作人时间 + `moderation_actions` + 奖励流水 |
| 改积分规则 | `point_rules` + `setting_history` + `audit_logs` |
| 改任意系统配置 | `settings` + `setting_history` + `audit_logs` |
| 开关功能模块 | `feature_flags` + `audit_logs` |
| 微信群发 | `broadcasts`(含预览快照与上游响应) + `approvals` + `audit_logs` |
| 站内公告 | `announcements` + `audit_logs` |
| 创建 / 取消活动 | `events` + `audit_logs`；取消须填 `cancel_reason` 并通知报名者 |
| 活动签到 | `event_checkins` + `points_ledger` |
| 兑换审批 / 发货 | `redemptions` + `order_events`(每次状态流转) + `audit_logs` |
| 手动触发同步 | `sync_jobs`(triggered_by=admin) + `audit_logs` |
| 存储裁剪 | `admin_tasks`(含 preview 与实际释放量) + `storage_snapshots` + `audit_logs` |
| 积分重算 | `admin_tasks` + 差异报告 + 修正流水 + `audit_logs` |
| 远程下线用户会话 | `sessions.revoked_*` + `audit_logs` |
| 处理举报 | `reports` + `moderation_actions` + 通知双方 + `audit_logs` |
| 处理申诉 | `appeals` + 可能的 `moderation_actions` 冲正 + `audit_logs` |
| 导出数据 | `admin_tasks` + `audit_logs`（导出是高危操作，必须留痕） |

---

# 十二、后台安全红线

1. 管理员账号**强制 Passkey 或 TOTP**，不接受纯密码
2. `danger_level ≥ 2` 的操作需**重新验证身份**（不是弹窗点确认）
3. `danger_level ≥ 3` 走 `approvals` **双人复核**
4. 后台**不能查看普通用户看不到的私聊内容**；确需时限 `owner` 且强制留痕并通知当事人
5. 后台路径可配 + 可选 IP 白名单
6. 所有后台写接口限流，防误操作批量伤害
7. `auditor` 角色存在的意义：让「看数据」不需要给写权限
8. **审计日志无删除接口** —— 包括 owner
