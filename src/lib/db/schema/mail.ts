import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import {
  MAIL_BANWORD_KINDS,
  MAIL_BLOCK_SCOPES,
  MAIL_BOX_KINDS,
  MAIL_BOX_STATUSES,
  MAIL_DOMAIN_KINDS,
  MAIL_DOMAIN_STATUSES,
  MAIL_DOMAIN_TIERS,
  MAIL_INGRESS_VERDICTS,
  MAIL_SLOT_SOURCES,
} from "@/lib/mail/kinds";

import { now, ulidPk } from "./_shared";

/**
 * 邮箱：域名池、地址、来信。设计与「为什么」见 `MAIL.md`。
 *
 * ═════════════════════════════════════════
 * 一条原则贯穿这几张表：命名空间的稀缺性决定价格
 * ═════════════════════════════════════════
 *
 * 在自己的域名上，前缀没人跟你抢 —— 所以免费、无限、不到期。
 * 在公共池上，`hi@某个好域名` 全站只有一个 —— 所以要抢、要花分、要到期。
 *
 * 这不是三套机制，是同一套机制在两种稀缺性下的两种表现，
 * 所以下面只有一张 `mail_boxes`，靠 `kind` 分叉。
 */

/**
 * 域名池。四类见 `lib/mail/kinds.ts`。
 *
 * `blocked` 必须是一等公民，而不是「不导入就完了」：不导入的话，
 * 那个域名在系统里根本不存在，于是**没有任何东西拦得住
 * 以后有人把它当成公共域名加回来**。
 */
export const mailDomains = sqliteTable(
  "mail_domains",
  {
    /** U 标签（人看的那个形态）。中文域名这里存中文 */
    domain: text("domain").primaryKey(),
    /**
     * A 标签。**SMTP 的信封里只能是这个** ——
     * 中文域名不转 punycode 的话，网关那一侧根本认不出收件人是谁。
     * ASCII 域名这一列和 `domain` 相同，不做 null：
     * 让所有查询只认一列，省掉每处都要写的 `?? domain`。
     */
    punycode: text("punycode").notNull(),

    kind: text("kind", { enum: MAIL_DOMAIN_KINDS }).notNull(),
    tier: text("tier", { enum: MAIL_DOMAIN_TIERS }),

    /** kind = owned 时的主人。公共池为空 */
    ownerUserId: text("owner_user_id"),
    /** 从哪次活动的哪条申请来的 —— 「这个域名凭什么是他的」要答得上 */
    sourceApplicationId: text("source_application_id"),

    /*
     * ── 四个开关 ──────────────────────────
     *
     * 池的类别决定默认值，但**逐个域名可以覆盖**。
     * 不给覆盖的话，「这个域名只发随机前缀」这种要求
     * 就只能靠新加一个 kind 来表达，而 kind 会越加越多。
     */
    /** 跑不跑一次性箱。reserved 恒为 0 —— 这正是靓号值钱的原因 */
    allowBurner: integer("allow_burner", { mode: "boolean" }).notNull().default(false),
    /** 能不能被申领（临时箱 / 长期箱） */
    allowClaim: integer("allow_claim", { mode: "boolean" }).notNull().default(false),
    /**
     * 一次性箱能不能自选前缀。
     *
     * 少数域名要关掉它：自选前缀 + 那几个域名，组合出来的地址
     * 才是有杀伤力的那种；随机的 12 位串没有这个问题。
     */
    allowCustomLocal: integer("allow_custom_local", { mode: "boolean" }).notNull().default(true),
    /**
     * 随机分配一次性箱时会不会选到它。
     *
     * 中文域名默认关：**很多网站的注册表单直接拒收 IDN 邮箱地址**，
     * 而一次性箱的全部用途就是去那些表单里注册。
     * 默认发一个用不了的地址，是这个功能最糟的第一印象。
     */
    inRandomRotation: integer("in_random_rotation", { mode: "boolean" }).notNull().default(false),

    /** catch-all：任意前缀都收。kind = owned 的默认开 */
    catchAll: integer("catch_all", { mode: "boolean" }).notNull().default(false),

    registrar: text("registrar"),
    registeredAt: integer("registered_at"),
    /**
     * ★ 域名本身的到期日 —— 不是邮箱的。
     *
     * 域名过期 = 挂在它上面的**所有邮箱同时消失**，而且**没有任何征兆**：
     * 邮件只是不再来了。100 个域名分散在不同的注册时间上，靠人记是记不住的。
     * 所以这一列有告警（health 那一轮，提前 30 / 14 / 7 天各报一次）。
     */
    domainExpiresAt: integer("domain_expires_at"),
    /** 上一次为这个域名报过的到期告警档位，避免每 5 分钟重复报 */
    expiryNoticeStage: integer("expiry_notice_stage"),

    /* ── DNS 体检 ────────────────────────── */
    mxOk: integer("mx_ok", { mode: "boolean" }),
    spfOk: integer("spf_ok", { mode: "boolean" }),
    dmarcOk: integer("dmarc_ok", { mode: "boolean" }),
    dnsCheckedAt: integer("dns_checked_at"),
    dnsDetail: text("dns_detail", { mode: "json" }),

    status: text("status", { enum: MAIL_DOMAIN_STATUSES }).notNull().default("pending"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),

    note: text("note"),
    createdBy: text("created_by"),
    createdAt: now("created_at"),
    updatedAt: now("updated_at"),
  },
  (t) => [
    index("mail_domains_kind_idx").on(t.kind, t.enabled),
    index("mail_domains_owner_idx").on(t.ownerUserId),
    // 网关来的信封地址是 A 标签，收信那条路每封都要查一次
    uniqueIndex("mail_domains_punycode_idx").on(t.punycode),
    index("mail_domains_expiry_idx").on(t.domainExpiresAt),
  ],
);

/**
 * 四种箱子。
 *
 * `burner` 和 `temp` 的差别不是「时间长短」那么简单：
 *   burner 不占槽位、24 小时、随机或长前缀 —— 它必须**零摩擦**
 *   temp   占槽位、30 天、自选前缀 —— 它是一个「地址」，不是一次动作
 * 把两者合成一个 kind 靠 `expires_at` 区分的话，
 * 「还剩几个槽位」这个判断就要在每处重新写一遍 `if (ttl > 1 天)`。
 */
export const mailBoxes = sqliteTable(
  "mail_boxes",
  {
    id: ulidPk(),
    userId: text("user_id").notNull(),

    localPart: text("local_part").notNull(),
    /** 域名的 U 标签，和 mail_domains.domain 对应 */
    domain: text("domain").notNull(),
    /** `local@punycode`，全小写。**信封比对只认这一列** */
    address: text("address").notNull(),

    kind: text("kind", { enum: MAIL_BOX_KINDS }).notNull(),
    /** 用户给它起的名字：「注册 Netflix 用的」 */
    label: text("label"),
    /** 静音：不发站内通知。脚本收信不需要有人被叮一下 */
    muted: integer("muted", { mode: "boolean" }).notNull().default(false),

    /**
     * 这个地址是**自选的**还是系统随机的。
     *
     * 单独一列而不是从 local_part 反推：随机串和一个人随手编的
     * 长前缀在形状上分不开，而「自选过的地址」在追查滥用时是第一个要筛的。
     */
    custom: integer("custom", { mode: "boolean" }).notNull().default(false),

    /** null = 不过期（自有域名的别名） */
    expiresAt: integer("expires_at"),
    /** 宽限期结束时间。见 MAIL.md 4.2 —— 到期不是立刻没收 */
    graceUntil: integer("grace_until"),
    renewedAt: integer("renewed_at"),
    renewCount: integer("renew_count").notNull().default(0),

    /** 占用的槽位。burner / alias 为空 */
    slotId: text("slot_id"),
    /** 年租那一笔订单，退款要靠它冲正 */
    orderId: text("order_id"),
    /** 通过哪把令牌开的。null = 网页开的。见 MAIL.md 8.3 */
    tokenId: text("token_id"),

    quotaBytes: integer("quota_bytes"),
    usedBytes: integer("used_bytes").notNull().default(0),
    messageCount: integer("message_count").notNull().default(0),
    unreadCount: integer("unread_count").notNull().default(0),
    lastReceivedAt: integer("last_received_at"),

    status: text("status", { enum: MAIL_BOX_STATUSES }).notNull().default("active"),

    createdAt: now("created_at"),
    updatedAt: now("updated_at"),
  },
  (t) => [
    /*
     * 地址唯一 —— 但**只在还活着的箱子之间**。
     *
     * 无条件唯一的话，一个过期回收的地址永远不能重新发出去，
     * 而「到期回收」正是这套设计的核心。部分唯一索引解决它，
     * 靠应用层查重解决不了：抢地址天然是并发的。
     */
    uniqueIndex("mail_boxes_address_idx")
      .on(t.address)
      .where(sql`${t.status} NOT IN ('expired','revoked')`),
    index("mail_boxes_user_idx").on(t.userId, t.status),
    index("mail_boxes_domain_idx").on(t.domain),
    index("mail_boxes_expiry_idx").on(t.status, t.expiresAt),
    index("mail_boxes_token_idx").on(t.tokenId),
  ],
);

/**
 * 槽位。**一行一个，这是真值**；用户身上的计数是缓存列。
 *
 * 和活动名额、`points` 余额同一个办法（SCHEMA.md 零节）——
 * 名额算错在这种东西上是事故，必须能事后重算比对。
 */
export const mailSlots = sqliteTable(
  "mail_slots",
  {
    id: ulidPk(),
    userId: text("user_id").notNull(),
    source: text("source", { enum: MAIL_SLOT_SOURCES }).notNull(),
    /** 买来的那一笔 */
    orderId: text("order_id"),
    ledgerId: text("ledger_id"),
    grantedBy: text("granted_by"),
    grantReason: text("grant_reason"),
    /** 撤销之后不删行 —— 审计要引用它 */
    revokedAt: integer("revoked_at"),
    revokedBy: text("revoked_by"),
    createdAt: now("created_at"),
  },
  (t) => [index("mail_slots_user_idx").on(t.userId, t.revokedAt)],
);

export const mailMessages = sqliteTable(
  "mail_messages",
  {
    id: ulidPk(),
    boxId: text("box_id").notNull(),

    /** RFC 的 Message-ID，用来串会话和去重 */
    rfcMessageId: text("rfc_message_id"),
    inReplyTo: text("in_reply_to"),

    /** 信封发件人（MAIL FROM）—— 这个骗不了，头里的 From 可以 */
    envelopeFrom: text("envelope_from"),
    fromAddr: text("from_addr"),
    fromName: text("from_name"),
    toAddr: text("to_addr").notNull(),
    subject: text("subject"),

    /** 纯文本进库，供搜索 */
    bodyText: text("body_text"),
    /**
     * HTML 落文件不进库。
     *
     * 两个理由：裁剪时删文件比 VACUUM 快得多，而且库小了备份才轻。
     * 搜索只需要纯文本，所以这一列存路径就够。
     */
    bodyHtmlPath: text("body_html_path"),

    size: integer("size").notNull().default(0),
    hasAttachments: integer("has_attachments", { mode: "boolean" }).notNull().default(false),
    attachmentMeta: text("attachment_meta", { mode: "json" }),

    spamScore: integer("spam_score"),
    spfPass: integer("spf_pass", { mode: "boolean" }),
    dkimPass: integer("dkim_pass", { mode: "boolean" }),
    dmarcPass: integer("dmarc_pass", { mode: "boolean" }),

    /**
     * 抽出来的验证码。见 MAIL.md 第九节。
     *
     * 存下来而不是每次渲染时现抽：列表页一屏几十封，
     * 现抽等于把正则跑几十遍，而结果永远一样。
     * **抽不出来就是 null，不做「猜一个」** —— 抽错一个数字比不抽更糟。
     */
    otpCode: text("otp_code"),

    receivedAt: now("received_at"),
    readAt: integer("read_at"),
    /** 正文到期清理时间，按等级算（30 / 60 天） */
    expiresAt: integer("expires_at"),
    purgedAt: integer("purged_at"),
  },
  (t) => [
    index("mail_messages_box_idx").on(t.boxId, t.receivedAt),
    // 网关重投（超时重试）不能存两份
    uniqueIndex("mail_messages_dedupe_idx").on(t.boxId, t.rfcMessageId),
    index("mail_messages_expiry_idx").on(t.expiresAt),
  ],
);

export const mailAttachments = sqliteTable(
  "mail_attachments",
  {
    id: ulidPk(),
    messageId: text("message_id").notNull(),
    filename: text("filename").notNull(),
    mime: text("mime"),
    size: integer("size").notNull().default(0),
    /**
     * 有没有真的落盘。**默认没有** —— 附件是吃盘大户，
     * 而九成的临时邮件里那个附件没人会点开。
     * 界面上要显示成「文件名 · 大小 · 未保存」，
     * 不能是一个点了没反应的下载按钮。
     */
    stored: integer("stored", { mode: "boolean" }).notNull().default(false),
    path: text("path"),
    expiresAt: integer("expires_at"),
    createdAt: now("created_at"),
  },
  (t) => [index("mail_attachments_message_idx").on(t.messageId)],
);

/**
 * 每一次投递的判决，**包括被拒的**。
 *
 * ═════════════════════════════════════════
 * 这张表是为一个必然会被问到的问题准备的
 * ═════════════════════════════════════════
 *
 * 「我朋友说发了，我怎么没收到」——
 * 收信这件事最常见的支持请求就是这一句，而没有这张表只能猜。
 * 只记成功的投递等于只记「没有问题的那些」。
 */
export const mailIngressLog = sqliteTable(
  "mail_ingress_log",
  {
    id: ulidPk(),
    envelopeFrom: text("envelope_from"),
    envelopeTo: text("envelope_to").notNull(),
    matchedBoxId: text("matched_box_id"),
    verdict: text("verdict", { enum: MAIL_INGRESS_VERDICTS }).notNull(),
    reason: text("reason"),
    size: integer("size").notNull().default(0),
    sourceIp: text("source_ip"),
    createdAt: now("created_at"),
  },
  (t) => [
    index("mail_ingress_to_idx").on(t.envelopeTo, t.createdAt),
    index("mail_ingress_verdict_idx").on(t.verdict, t.createdAt),
  ],
);

/**
 * 前缀禁用词。
 *
 * **和 `sensitive_words` 是两张表**，虽然匹配方式一样：
 * 帖子正文要挡的是脏话和敏感内容，邮箱前缀要挡的是
 * `admin` `postmaster` `security` `billing` 这类**会让收信人误判身份**的词。
 * 共用一张表的结果是两边互相误伤，而且谁都不敢删。
 *
 * 四种匹配方式定义在 `lib/mail/address-rules.ts` —— 判定在那一层，
 * 而那一层不许引数据库。
 */
export const mailBanwords = sqliteTable(
  "mail_banwords",
  {
    id: ulidPk(),
    word: text("word").notNull(),
    kind: text("kind", { enum: MAIL_BANWORD_KINDS }).notNull().default("exact"),
    reason: text("reason"),
    /**
     * 系统内置的那几条（postmaster / abuse）不许删。
     * RFC 5321 要求域名能收这两个地址，而它们是收
     * 「你们家域名在发垃圾邮件」这种投诉的唯一通道 ——
     * 发给用户的话，我们会在完全不知情的情况下被拉黑。
     */
    builtin: integer("builtin", { mode: "boolean" }).notNull().default(false),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdBy: text("created_by"),
    createdAt: now("created_at"),
  },
  (t) => [uniqueIndex("mail_banwords_word_idx").on(t.word, t.kind)],
);

/** 发件人黑名单。作用域三档：全站 / 某个域名 / 某个箱子 */
export const mailBlocks = sqliteTable(
  "mail_blocks",
  {
    id: ulidPk(),
    scope: text("scope", { enum: MAIL_BLOCK_SCOPES }).notNull(),
    /** scope 对应的目标：域名 / box id / 全站为空 */
    target: text("target"),
    /** 挡的是完整发件地址还是发件域名 */
    matchKind: text("match_kind", { enum: ["sender", "sender_domain"] }).notNull(),
    pattern: text("pattern").notNull(),
    reason: text("reason"),
    createdBy: text("created_by"),
    createdAt: now("created_at"),
  },
  (t) => [index("mail_blocks_scope_idx").on(t.scope, t.target)],
);

export const mailEvents = sqliteTable(
  "mail_events",
  {
    id: ulidPk(),
    boxId: text("box_id"),
    domain: text("domain"),
    event: text("event").notNull(),
    actorId: text("actor_id"),
    actorKind: text("actor_kind", { enum: ["user", "admin", "system", "token"] })
      .notNull()
      .default("system"),
    /** 通过哪把令牌做的 —— 「这个地址是谁开的」出事那天是唯一要问的 */
    tokenId: text("token_id"),
    detail: text("detail", { mode: "json" }),
    createdAt: now("created_at"),
  },
  (t) => [
    index("mail_events_box_idx").on(t.boxId, t.createdAt),
    index("mail_events_domain_idx").on(t.domain, t.createdAt),
  ],
);
