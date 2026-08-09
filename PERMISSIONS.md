# 权限与可见性体系

「未登录可看论坛」把权限从「登录/未登录」二值变成了分层问题。
这套体系要同时满足：论坛对外开放、群聊内容严格隔离、身份组灵活可配、后台看得懂。

---

# 一、可见性分层

每个内容对象都有一个 `visibility`：

| 级别 | 谁能看 | 搜索引擎 |
|---|---|---|
| `public` | 所有人，含未登录 | ✅ 索引 |
| `unlisted` | 所有人，含未登录 | ❌ `noindex` + 不进站内公开列表 |
| `member` | 已登录且已绑定的成员 | ❌ |
| `role` | 指定身份组（`visibility_role_id`） | ❌ |
| `group` | 指定群的成员（`visibility_group_id`） | ❌ |
| `private` | 仅作者本人与管理员 | ❌ |

**判定顺序**：对象自身 `visibility` → 受版块 `max_visibility` 封顶 → 再叠加对象状态
（草稿/已删除/被隐藏）。取最严者。

## 1.1 三条硬约束（写进代码，不可配置绕过）

**① 群聊消息永远不可 `public` / `unlisted`。**
`messages` 表的内容只能通过「该群成员」这一条路径访问，没有例外。

**② 群聊转帖（`post_sources` 非空）默认 `visibility = group`，锁死在原群范围。**
想提升到 `member` 或 `public`，必须同时满足：
- 管理员审核通过
- **所有被引用消息的原作者都已同意**（`post_sources.consent_status = 'granted'`）
- 提升操作写 `audit_logs`，并通知所有原作者

> 这是整套设计里最容易出事的地方。「一键成帖」+「未登录可见」如果没有这道闸，
> 一次误操作就能把私密群聊送上公网，而且是不可撤回的（已被抓取）。

**③ `external` 用户与未登录用户永远看不到任何 `messages` 派生内容**，
包括搜索结果、精华摘要、链接库里带群聊上下文的条目、成员目录里的发言统计。

## 1.2 版块可见性

```
boards.default_visibility   新帖默认值
boards.max_visibility       封顶：该版块任何帖子都不能超过此级别
boards.visible_to           版块本身在导航里对谁可见
boards.post_permission      谁能发帖（role / level / group）
boards.reply_permission     谁能回复
```

典型配置：

| 版块 | max_visibility | 说明 |
|---|---|---|
| 公开讨论 | `public` | 未登录可读，对外展示社区面貌 |
| 项目展示 | `public` | 成员作品，适合传播 |
| 问答 | `public` | 沉淀 SEO 价值最高 |
| 内部事务 | `member` | 登录成员可见 |
| 群聊沉淀 | `group` | **封顶就是 group**，从结构上杜绝泄露 |
| 管理组 | `role` | 仅管理员 |

---

# 二、未登录访客能做什么

| 能 | 不能 |
|---|---|
| 浏览 `public` 版块与帖子 | 发帖、回复、点赞、收藏 |
| 搜索 `public` 帖子 | 搜索群消息 |
| 查看活动列表与详情 | 报名活动 |
| 查看公开榜单（若群配置 `public_leaderboard`） | 查看成员详细画像 |
| 查看成员目录基础卡片（若未开隐私） | 查看任何人的发言统计 |
| 注册 / 绑定入口 | 一切写操作 |

访客态设计要点：
- 未登录看到的帖子页面，回复框位置显示「登录后参与讨论」+ 绑定入口 → **这是转化路径**
- `public` 帖子生成 OG 卡片（标题/摘要/作者/封面），微信里分享链接有预览图
- 访客访问也计入 `posts.view_count`，但按 IP 去重

---

# 三、统一判定入口

**所有权限判断只有一个函数**，任何地方不得自行拼 `if (role === ...)`：

```ts
can(actor, permission, resource?) → { allowed: boolean, reason: string }
```

`actor` 可以是：登录用户 / 访客(anonymous) / 系统 / 模块。
判定链（**先拒后允**）：

```
1. actor 被封禁 / 会话失效        → deny
2. 资源已删除或隐藏（非管理员）    → deny
3. permission_overrides 显式拒绝   → deny   ← 用户级例外优先级最高
4. role_permissions granted=0      → deny   ← 显式拒绝压过允许
5. 可见性检查（第一节）未通过      → deny
6. permission_overrides 显式允许   → allow
7. 任一 user_roles 提供该权限
   且 scope 匹配 resource          → allow
8. 兜底                            → deny
```

**默认拒绝**。新增功能忘了配权限，结果是「没人能用」而不是「所有人都能用」——
这个方向的错误是安全的。

`reason` 必须返回，用于：后台调试、给用户友好提示（「需要 L3 才能发帖」）、审计。

---

# 四、身份组设计（呼应 SCHEMA.md 第二节）

## 4.1 一个人可以同时属于多个身份组

- 权限取**并集**（除非有显式拒绝）
- 显示取 `priority` 最高的那个的 `color`/`icon`/`badge_style`
- 名片上可展示多个身份组徽章

## 4.2 范围化（scope）是核心

```
user_roles(user_id, role_id, scope_type, scope_id, expires_at)
```

| 例子 | scope_type | scope_id |
|---|---|---|
| 全站管理员 | `null` | `null` |
| 技术版版主 | `board` | `board_xxx` |
| Agentic Lab #1 群管理 | `group` | `20000000001@chatroom` |
| 某活动的审核员（临时） | `activity` | `act_xxx` + `expires_at` |

判定时 `resource` 携带自己的归属（哪个版块 / 哪个群 / 哪个活动），与 scope 比对。

## 4.3 自动授予

`roles.auto_grant_rule` 复用活动系统的资格引擎（MODULES.md §3.1）：

```jsonc
{ "all": [{ "metric": "level", "op": ">=", "value": 8 },
          { "metric": "accepted_answers", "op": ">=", "value": 20 }] }
```

定时任务每日评估，满足则授予、不满足则回收（可配是否回收），全部进 `audit_logs`。
「元老」「活跃贡献者」这类荣誉身份组就靠这个自动运转，不用人工维护。

## 4.4 临时提权

`expires_at` 到期自动撤销并记日志。
活动期间给某人临时审核权、新管理员试用期 —— 都用这个，避免权限只增不减。

---

# 五、后台怎么直观管理

这是你特别要求的部分。权限系统最大的问题不是设计不出来，是**管理员看不懂自己配了什么**。

## 5.1 权限矩阵（主界面）

行 = 身份组，列 = 权限点（按 category 分组折叠），格子三态：

```
                 forum.post   forum.delete   points.adjust   user.ban   system.settings
  owner              ✓             ✓              ✓             ✓            ✓
  admin              ✓             ✓              ✓             ✓            ✗
  moderator          ✓             ✓(限版块)       ○             ○            ○
  group_admin        ✓             ○              ○             ○            ○
  auditor            ○             ○              ○             ○            ○
  member             ✓             ○              ○             ○            ○
  external           ○             ○              ○             ○            ○
  guest(未登录)       ○             ○              ○             ○            ○

  ✓ 允许   ✗ 显式拒绝   ○ 未授予
```

- 点格子直接切换三态，支持框选批量
- **保存前显示 diff**：「moderator 将获得 3 项权限、失去 1 项，影响 4 人」
- 保存后写 `role_permissions` + `audit_logs`（含前后快照）
- 危险权限（`danger_level ≥ 2`）的格子标红，勾选时二次确认

## 5.2 「以某身份预览」

选一个身份组或具体某个人 → **整站切换成他的视角**，看到的导航、版块、帖子、
按钮完全按他的权限渲染，右上角常驻红色横幅「正在以 XX 身份预览」。

> 这是验证权限配置唯一可靠的方式。看矩阵永远想不清楚"版主到底能不能删别人的帖"，
> 切过去点一下就知道了。

## 5.3 权限反查

选一个权限点 → 列出**所有拥有它的人**及来源：

```
user.ban  当前有 4 人拥有：
  张三   ← 角色 owner（全站）
  李四   ← 角色 admin（全站）        授予人 张三 · 2026-07-02
  王五   ← 角色 admin（全站）        授予人 张三 · 2026-07-15 · 30 天后到期
  赵六   ← permission_override       授予人 李四 · 2026-08-01 · 理由「临时处理刷屏」
```

> 定期回顾"谁能封人""谁能改积分"是最基本的治理动作。没有反查就只能靠记忆。

## 5.4 用户权限详情页

在用户档案里显示：
- 拥有的身份组（含 scope、授予人、时间、到期）
- 有效权限点全集（可展开看每一项来自哪个来源）
- 权限变更历史时间线
- 一键「以此人身份预览」

## 5.5 可见性检查器

输入一个帖子 → 显示「以下角色可见 / 不可见」以及判定原因链：

```
帖子 #1234「群里聊到的 MCP 鉴权方案」
  visibility = group(20000000001@chatroom)  ← 来源：群聊转帖，默认锁定
  版块封顶  = group                          ← 群聊沉淀版
  ✓ 该群成员 (87 人)
  ✗ 其他成员      原因：visibility=group 且不在该群
  ✗ external      原因：硬约束③ 群聊派生内容
  ✗ 未登录        原因：硬约束③
  ⚠ 提升到 public 需：管理员审核 + 3 位原作者同意（当前 0/3）
```

## 5.6 变更安全网

- 所有权限变更进 `audit_logs`，可查可比对
- 保存前 diff 预览 + 影响人数
- **误操作回滚**：权限矩阵有版本快照，可一键回退到某个时间点
- 不允许移除最后一个 `owner`（代码级硬拦截）
- 修改自己所属身份组的权限时，额外警告（防止把自己锁在门外）

---

# 六、涉及的表补充

在 SCHEMA.md 基础上增加：

```
posts.visibility              TEXT
posts.visibility_role_id      TEXT NULL
posts.visibility_group_id     TEXT NULL
posts.visibility_locked       INTEGER    -- 群聊转帖锁定，需审核才能改
posts.og_image, og_desc                  -- 未登录分享卡片

post_sources.consent_status   TEXT       -- pending | granted | denied | waived
post_sources.consent_log      TEXT       -- 每位原作者的同意记录

boards.default_visibility / max_visibility / visible_to
boards.post_permission / reply_permission

role_snapshots       id, taken_at, taken_by, payload TEXT, note
                     -- 权限矩阵版本快照，支持回滚

visibility_audit     id, target_type, target_id,
                     from_visibility, to_visibility,
                     actor_id, reason, consent_snapshot, created_at
                     -- ★ 可见性提升单独留痕，这是最敏感的操作

short_links          code PK, target_url, post_id NULL, run_id NULL,
                     clicks, created_by, created_at, expires_at
                     -- 回推微信群用
```
