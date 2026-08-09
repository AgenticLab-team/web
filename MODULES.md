# 可插拔模块系统与活动框架

> **读者**：要做活动或模块的人
> **性质**：⚠ **混合**：第三、四节是现状；**第二节（module.json / SDK / 五张 module_* 表）从未采纳** —— 实际走 `src/lib/modules/registry.ts` 的写死清单
> **最后核对**：2026-08-10

活动会很多、形态各异（域名发放、临时邮箱、线下聚会、抽奖、内测名额、周边兑换……）。
如果每来一个活动就改一次核心代码，三个月后代码库就烂了。

**解法：核心提供"活动骨架 + 模块运行时"，每类活动是一个可装可卸的模块。**

---

# 一、为什么大多数活动其实是同一个状态机

把域名发放拆开看：

```
资格判定 → 申请（填表 + 校验）→ 占名额 → 审核 → 履约 → 回填结果 → 通知
```

抽奖、内测名额、周边兑换、线下报名，骨架完全一样，只是三处不同：
1. **申请表单长什么样**（域名活动填域名；聚会活动填餐饮忌口）
2. **校验规则是什么**（域名要查是否已注册；聚会要查是否同城）
3. **履约怎么做**（域名要人工统一注册；周边要发货）

→ **核心实现这套状态机与资格引擎，模块只实现那三处差异。**

---

# 二、模块运行时

## 2.1 目录结构

```
/modules/
  domain-giveaway/
    module.json          ← manifest，纯静态可读，不执行代码
    index.ts             ← defineModule()
    migrations/001_init.sql
    admin/               ← 后台页面
    public/              ← 前台页面
    locales/
  temp-mailbox/
  weekly-digest/
```

## 2.2 Manifest

```jsonc
{
  "key": "domain-giveaway",
  "name": "域名发放活动",
  "version": "1.0.0",
  "author": "agenticlab",
  "description": "限量域名申请登记与统一注册回填",
  "coreVersion": ">=1.0.0",
  "capabilities": ["activity", "admin-page", "user-page", "cron", "notify"],
  "grants": ["points.read", "user.read", "notify.send", "storage.own", "audit.write"],
  "tables": ["mod_domain_claims", "mod_domain_tlds", "mod_domain_reserved_words"],
  "permissions": ["domain.review", "domain.fulfill", "domain.config"],
  "configSchema": { /* JSON Schema → 后台自动生成配置表单 */ },
  "removable": true,
  "dataOnUninstall": "keep"   // keep | archive | purge
}
```

> `grants` 像手机 App 的权限声明：**安装时后台弹出「此模块将获得：读取积分 / 发送通知 / 写入自有数据」，需管理员确认。**
> 模块拿不到未声明的能力。

## 2.3 模块 SDK（模块唯一能碰核心的通道）

```ts
export default defineModule({
  key: 'domain-giveaway',

  // 生命周期
  async onInstall(ctx)   {}   // 建表、写默认配置
  async onEnable(ctx)    {}   // 注册路由、挂钩子
  async onDisable(ctx)   {}   // 即时生效，不删数据
  async onUninstall(ctx) {}   // 按 dataOnUninstall 处理

  // 活动钩子
  async onValidate(ctx, application)  {}  // 校验申请（域名可用性）
  async onReserve(ctx, application)   {}  // 占名额前的自定义逻辑
  async onApprove(ctx, application)   {}
  async onFulfill(ctx, application)   {}  // 履约
  async onFail(ctx, application, err) {}  // 失败处理（退名额）

  // 通用钩子
  async onCron(ctx, job)              {}
  async onUserBound(ctx, user)        {}
  async onActivityClose(ctx, activity){}
})
```

`ctx` 提供且**仅**提供：

| API | 说明 |
|---|---|
| `ctx.db` | **仅限本模块命名空间的表**（`mod_<key>_*`），越界直接抛错 |
| `ctx.storage` | 命名空间 KV，小模块不必建表 |
| `ctx.config` | 本模块配置（后台可视化编辑） |
| `ctx.users.get(id)` | 只读用户信息，字段按 `grants` 裁剪 |
| `ctx.points.grant/deduct()` | 走 `points_ledger`，自动带 reason 与 idempotency |
| `ctx.notify(userId, ...)` | 站内 / 邮件 |
| `ctx.eligibility.check(rule, userId)` | 复用核心资格引擎 |
| `ctx.audit(action, before, after)` | 写 `audit_logs`，actor 记为模块 |
| `ctx.http` | 出站请求，**受白名单 + 超时 + 限流约束** |
| `ctx.log` | 结构化日志，进 `module_events` |

## 2.4 故障隔离

- 每个钩子调用包 `try/catch` + 超时（默认 10s，可配）
- 连续失败 N 次（默认 5）→ **自动熔断并 disable 模块**，告警管理员
- 模块异常绝不冒泡到核心请求链路
- `module_events` 记录每次钩子的入参摘要、耗时、结果、错误栈

## 2.5 热插拔的诚实说明

Node 的 `import` 无法真正卸载已加载模块。所以：

| 操作 | 是否需重启 | 生效速度 |
|---|---|---|
| 启用 / 停用（`enabled` 开关） | **不需要** | 即时 —— 路由与钩子直接跳过 |
| 改模块配置 | 不需要 | 即时 |
| 安装新模块 / 升级模块代码 | **需要**（systemd restart，约 300ms） | 后台按钮触发，滚动重启无感 |
| 卸载模块 | 停用即时生效，代码移除需重启 | — |

**日常运营 99% 的场景是启用/停用/改配置，这些都不用重启。**
不假装能做到无重启热替换代码 —— 那需要子进程隔离，对这个体量不值得。

## 2.6 模块系统数据表

```
modules            key PK, name, version, installed_version,
                   status(installed|enabled|disabled|error|circuit_open),
                   manifest TEXT, config TEXT, grants TEXT,
                   checksum, sort,
                   installed_at, enabled_at, disabled_at, disabled_by,
                   last_error, error_count, circuit_opened_at,
                   created_by

module_migrations  module_key, version, checksum, applied_at, rolled_back_at
module_storage     module_key, key, value, updated_at   PK(module_key, key)
module_events      id, module_key, hook, ref_type, ref_id,
                   status(ok|error|timeout), duration_ms,
                   input_digest, output_digest, error, created_at
module_grants_log  id, module_key, grants_before, grants_after,
                   approved_by, created_at
```

---

# 三、通用活动框架（核心，不属于任何模块）

## 3.1 资格引擎（声明式）

```jsonc
{
  "all": [
    { "metric": "quality_messages", "scope": "any_group", "window": "30d", "op": ">=", "value": 50 },
    { "metric": "messages",         "scope": "any_group", "window": "30d", "op": ">=", "value": 200 },
    { "metric": "level",            "op": ">=", "value": 3 },
    { "metric": "bound_since",      "op": "<=", "value": "2026-07-25" },
    { "metric": "in_group",         "value": ["20000000001@chatroom"] },
    { "not": { "metric": "has_role", "value": "banned" } }
  ]
}
```

可用 metric：`messages` `quality_messages` `active_days` `streak` `level` `points`
`points_total` `bound_since` `in_group` `has_role` `has_badge` `forum_posts`
`accepted_answers` `event_attendance` `previous_wins`(本活动或指定活动是否中过)

**★ 后台配规则时实时显示「当前符合条件的有 N 人」并可导出名单。**
这一条极其重要 —— 60 个名额，你需要在开放前就知道是 500 人抢 60 个，
还是只有 12 个人够格。规则调一下数字，人数立刻重算。

## 3.2 状态机

**活动**
```
draft → scheduled → open → closed → reviewing → fulfilling → completed
                      ↓                                          ↑
                  cancelled ←──────────────────────────────────┘
```

**申请**
```
draft → submitted → validating → ┬→ invalid（校验不过，可改后重提）
                                 ├→ waitlisted（名额满，排队）
                                 └→ approved → fulfilling → ┬→ fulfilled
                                                            └→ failed → 退名额 → 可重提
   任意态 → cancelled（用户撤回） / expired（超时未处理）
```

## 3.3 核心表

```
activities            id, module_key, title, cover, description, rules_md,
                      config TEXT,              -- 模块专属配置
                      eligibility TEXT,         -- 3.1 的规则 JSON
                      quota_total, quota_used, quota_reserved,
                      per_user_limit, allow_waitlist, waitlist_cap,
                      opens_at, closes_at, review_deadline, fulfill_deadline,
                      status, visibility, announce_channels TEXT,
                      result_public INTEGER,
                      created_by/updated_by/cancelled_by/cancel_reason,
                      created_at/updated_at

activity_applications id, activity_id, user_id,
                      payload TEXT,             -- 模块专属字段
                      normalized_key TEXT,      -- 唯一性判据（域名等）
                      status,
                      eligibility_snapshot TEXT,   -- ★ 见下
                      validation_result TEXT,
                      priority INTEGER, queue_position,
                      reviewed_by, reviewed_at, review_note,
                      fulfilled_at, fulfill_result TEXT, failure_reason,
                      retry_of NULL,            -- 失败后重提，指向原申请
                      idempotency_key,
                      created_at/updated_at
    UNIQUE(activity_id, normalized_key) WHERE status NOT IN
          ('invalid','rejected','cancelled','expired','failed')

activity_events       id, application_id, activity_id,
                      from_status, to_status,
                      actor_id, actor_kind(user|admin|system|module),
                      note, payload, created_at

activity_quota_log    id, activity_id, delta, balance_after, reason,
                      application_id, operator_id, created_at
```

**`eligibility_snapshot` 是关键设计**：申请提交那一刻，把此人当时的
「30 天高质量发言 87 条、等级 4、绑定于 6 月 20 日」冻结进快照。
事后有人质疑「凭什么他能申请我不能」，翻快照即可，无从争议。
没有快照，两周后数据变了就说不清了。

**`activity_quota_log` 是名额的唯一真值**，`quota_used` 只是缓存列，后台可比对重算。
名额算错在限量活动里是致命事故。

## 3.4 并发与超卖

60 个名额被 300 人同时抢，必须保证不超卖、不重复：

- 名额扣减在**单事务**内完成：`UPDATE activities SET quota_used = quota_used + 1
  WHERE id = ? AND quota_used < quota_total` → 影响行数为 0 即已满，转候补
- 唯一性（同一域名不能两人登记）靠**部分唯一索引**，不靠应用层查重
- SQLite WAL 模式 + `BEGIN IMMEDIATE`，写串行化天然规避竞态
- 每次扣减写 `activity_quota_log`，可事后审计

---

# 四、模块①：域名发放活动

## 4.1 本期形态（按你的要求：先只做登记）

> 明天开放半天，60 个名额。够格者登记一个 **≥5 字符**的域名，
> 系统检查是否已被注册，未注册则进等待列表。你后续统一注册，
> 回填成功/失败，系统自动通知并处理后续。

**用户流程**
1. 打开活动页 → 看到自己的资格状态（够格 / 差多少条）与剩余名额
2. 输入想要的域名 → **实时可用性检查**（防抖 + 限流）
3. 提交登记 → 占用 1 个名额 → 状态 `waitlisted`（等待统一注册）
4. 你注册完回填 → `fulfilled`（成功，附域名管理入口）或 `failed`
5. 失败者：名额退回、可改名重提（活动窗口内）

**管理员流程**
1. 后台一键**导出 CSV**（`fqdn, user, submitted_at, availability, checked_at`）
2. 你拿去统一注册
3. **导入结果 CSV**（`fqdn, success|fail, reason, cost, expires_at`）
4. 系统批量回填 → 自动通知所有人 → 失败者名额退回并开放重提
5. 全程进 `activity_events` 与 `audit_logs`

## 4.2 域名校验

**格式规则**（全部后台可配）
- 主体（SLD）长度 ≥5，≤63
- 字符集 `a-z0-9-`，不可以 `-` 开头/结尾，不可含 `--`（xn-- punycode 保留前缀）
- 中文域名转 punycode 后再校验长度
- TLD 必须在允许列表内（`mod_domain_tlds`，后台维护，可标注价格提示）
- 保留词库：`www` `mail` `admin` `api` `ns1` `agenticlab` + 品牌词 + 敏感词
  （支持 exact / prefix / contains / regex 四种匹配）

**可用性检查**
- **首选 RDAP**（`https://rdap.org/domain/<fqdn>`）：标准化 JSON，比 whois 稳定得多。
  404 = 未注册；200 = 已注册；其它 = unknown
- 回退：权威 whois → DNS NS 查询（有 NS 记录基本可判定已注册）
- **结果缓存 10 分钟**（`mod_domain_checks`），避免刷接口被 ban
- 限流：每用户每分钟 10 次、每小时 60 次；全局并发上限
- ⚠️ **检查结果是参考不是保证** —— 可能是溢价域(premium)、可能被抢注、
  可能注册商不支持。所以状态机必须有 `failed` 回填路径，UI 上也要明说这一点。

## 4.3 交付后的能力（后续里程碑）

- **DNS 管理**：服务器上跑 PowerDNS（带 HTTP API）或对接注册商 API；
  用户在网页上管理自己域名的 A / AAAA / CNAME / MX / TXT 记录，带记录数上限与校验
- **收邮件**：MX 指向本站邮件网关，接入模块② 临时邮箱

## 4.4 模块表

```
mod_domain_claims          id, application_id, user_id,
                           sld, tld, fqdn, punycode,
                           availability(unknown|available|taken|premium|error),
                           checked_at, check_source(rdap|whois|dns), check_raw,
                           registrar_status(pending|exported|ordered|success|failed),
                           exported_at, registered_at, expires_at, cost,
                           dns_zone_id NULL, mail_enabled,
                           admin_note, created_at/updated_at
    UNIQUE(fqdn) WHERE registrar_status <> 'failed'

mod_domain_tlds            tld PK, enabled, price_hint, note, sort
mod_domain_reserved_words  id, word, kind(exact|prefix|contains|regex), reason, enabled
mod_domain_checks          id, fqdn, result, source, latency_ms, raw, checked_at
                           -- 兼作缓存与限流审计
mod_domain_batches         id, kind(export|import), file_path, row_count,
                           success_count, fail_count, operator_id, created_at
                           -- 每一次导出/导入都留底，可回溯
```

---

# 五、模块②：临时邮箱

## 5.1 形态

由**多个域名组成的池**，用户可申请一个或多个收件箱：`anything@pool-domain.tld`

- 临时箱：有效期可配（默认 7 天），到期自动回收地址
- 永久箱：高等级或域名活动获奖者可申请，绑定在自己的域名上
- 网页收信、查看正文、下载附件（受限）、转发到自己邮箱

## 5.2 磁盘策略（必须严格，邮件是吃盘大户）

沿用 docs/archive/PLAN-2026-08-08.md §7.3 的铁律：

- 邮件正文保留 **30 天**（可配），到期自动清理
- **附件默认不落盘**，只存元信息（文件名/大小/类型）
- 若开启附件存储：单封 ≤2MB、单用户配额 ≤50MB、全局池 ≤1GB，LRU 淘汰
- HTML 正文存文件不存库（便于批量清理），纯文本存库供搜索
- 每个箱子有 `used_bytes` 配额，超限拒收并通知

## 5.3 反滥用

临时邮箱极易被拿去注册垃圾账号：
- 仅限已绑定的 `member`，且有等级门槛
- 每人箱子数量上限
- 发信能力**默认关闭**（只收不发）—— 开了发信就要面对 IP 信誉、SPF/DKIM/DMARC、
  被列黑名单的一整套麻烦，且一旦被滥用会连累主域名
- 收信频率异常告警

## 5.4 模块表

```
mod_mail_domains     domain PK, status, mx_verified, spf_ok, dkim_ok, dmarc_ok,
                     capacity, used, enabled, owner_user_id NULL, checked_at
mod_mail_boxes       id, user_id, local_part, domain, address UNIQUE,
                     kind(temporary|permanent), expires_at,
                     quota_bytes, used_bytes, message_count,
                     forward_to, forward_verified,
                     status(active|full|expired|disabled), created_at
mod_mail_messages    id, box_id, upstream_message_id, from_addr, from_name,
                     to_addr, subject, body_text, body_html_path,
                     size, has_attachments, attachment_meta TEXT,
                     spam_score, dkim_pass, received_at, read_at, expires_at
mod_mail_attachments id, message_id, filename, mime, size,
                     stored INTEGER, path NULL, expires_at
mod_mail_events      id, box_id, event(created|received|rejected|expired|purged),
                     detail, created_at
```

---

# 六、模块③：每周论坛精选回推微信群

## 6.1 为什么它重要

网站的内容如果只在网站里，群友不会主动去看。**每周把精选回推到群里，
是把 45,000 条群消息沉淀成的价值再送回群里** —— 这是网站与群之间的正向循环。

注意：这与「网站不能代用户发消息」不冲突 —— **这是系统/管理员行为，不是用户行为**。

## 6.2 选帖算法

```
score = 3×加精 + 1.0×点赞 + 1.5×回复数 + 2.0×独立回复人数
      + 0.02×浏览 + 2×被采纳答案 − 5×(已推送过)
```
约束：
- 取 Top N（默认 5，可配）
- **同一作者最多 2 篇**（避免变成个人秀）
- 排除：已推送过的、被隐藏/删除的、`visibility` 不允许公开的
- 只推 `visibility ∈ {public, unlisted}` 的帖子 —— **群聊转帖默认不进精选**

## 6.3 发送流程（半自动，兼顾安全与省事）

```
周日 20:00 cron → 生成候选 → 打分排序 → 生成文案与短链
                → 落 draft + 通知管理员
                → 管理员在后台预览、可增删调序、可改文案
                → 一键确认 → 走 broadcasts → POST /send/link 或 /send/text
```

- 可配「全自动发送」，但**默认半自动** —— 自动发东西到 12 个真实微信群，
  出一次错就是社死现场，值得一次点击的成本
- 用 `/send/link` 发链接卡片比纯文本好看；失败回退 `/send/text`
- **硬限流**：每群每周最多 1 次，不受配置影响（防误操作连发）
- 每篇帖子生成短链，可统计点击回流 —— 这是衡量"回推是否有效"的唯一指标
- 全程落 `broadcasts`（含预览快照与上游响应），可与 `/send/history` 对账

## 6.4 模块表

```
mod_digest_runs     id, period_start, period_end,
                    status(generating|draft|approved|sending|sent|failed|skipped),
                    candidates TEXT, selected TEXT,
                    content_text, content_preview,
                    broadcast_id, approved_by, approved_at,
                    sent_at, created_at
mod_digest_targets  id, run_id, conv_id, status, sent_at,
                    upstream_msg_id, error, retry_count
mod_digest_links    id, run_id, post_id, short_code UNIQUE,
                    clicks, unique_clicks, last_click_at
mod_digest_clicks   id, short_code, user_id NULL, ip_hash, ua, created_at
mod_digest_history  post_id, run_id, pushed_at   -- 去重，同一帖不重复推
```

---

# 七、模块④⑤…（未来）

框架建好后，这些都只是新增一个模块目录：

| 模块 | 说明 |
|---|---|
| `lottery` | 抽奖（资格引擎 + 随机开奖 + 可验证种子） |
| `beta-access` | 内测名额发放 |
| `merch` | 周边订单（复用商店 + 物流状态） |
| `meetup` | 线下聚会（复用活动 + 签到码 + 同城筛选） |
| `bounty-board` | 悬赏任务 |
| `api-credits` | API 额度发放 |
| `mentor-match` | 导师匹配（复用成员目录标签） |

**每一个都不需要改核心代码。** 这就是这套设计要买的东西。

---

# 八、后台管理界面

## 模块管理页
- 已安装模块卡片：图标、名称、版本、状态、启停开关、健康度（近 7 天钩子成功率）
- 安装：上传/选择模块 → **展示 `grants` 权限清单要求确认** → 跑 migration → 启用
- 配置：由 `configSchema` **自动生成表单**，改动进 `setting_history` + `audit_logs`
- 卸载：三选一（保留数据 / 归档导出 / 彻底删除），二次确认
- 事件日志：该模块所有钩子调用记录，失败可查错误栈
- 熔断状态与手动恢复

## 活动管理页
- 活动列表：状态、名额进度条、申请数、时间窗口
- 新建活动：选模块 → 填基础信息 → **可视化配资格规则（实时显示符合人数）**
  → 配名额与时间 → 预览 → 发布
- 申请管理：列表（可按状态筛选）、批量审批、单条详情（含资格快照）
- **批量导出 / 导入**（域名活动的核心运营动作）
- 名额流水、状态流转时间线
- 一键公告到微信群（走 broadcasts）
