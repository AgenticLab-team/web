/**
 * 邮箱模块的共享词汇表。**只有常量，没有依赖**。
 *
 * 单独一个文件的理由和 `shop/types.ts` 一样：判定发生在纯逻辑层，
 * 而那一层不许 import `@/lib/db`（那会把 drizzle 拖进测试，
 * 于是没人再为一个边界情况多写一条断言 —— 见 ARCHITECTURE.md 一节）。
 *
 * 所以枚举住在这里，schema 和规则层都引它，**谁都不引对方**。
 */

/**
 * 域名分五类。
 *
 * ─────────────────────────────────────────
 * `admin` 和 `blocked` 的差别是「收不收信」
 * ─────────────────────────────────────────
 *
 * 两者都**不进任何公共池**，谁都申领不到。区别在于：
 *
 *   `blocked` —— **连 MX 都不配**。发到这里的信在 DNS 那一层就没了，
 *                我们什么都看不到。
 *   `admin`   —— MX 配着、信收得到，但**只有管理员能在上面开地址**。
 *
 * 为什么要有 `admin` 这一档：那 11 个商标近似的域名注册下来是为了
 * **不让别人注册**，而配上 MX 之后还多一件事 ——
 * **看得见有人在试探**。发到 `security@某商标.icu` 的每一次投递
 * 都会进 `mail_ingress_log`，而没有 MX 的话那些尝试连痕迹都不留。
 *
 * 危险的从来不是收信，是**身份**：拿这种地址去发信、去做域名验证。
 * 而发信全站默认关死，开地址又只有管理员做得到、每次留痕。
 */
export const MAIL_DOMAIN_KINDS = ["owned", "temp", "reserved", "admin", "blocked"] as const;
export type MailDomainKind = (typeof MAIL_DOMAIN_KINDS)[number];

/**
 * 五个类型的中文名。**只有这一份。**
 *
 * 原来后台列表和域名编辑器各写了一份，而且措辞还不一样
 * （「有主」对「有主域名」、「一次性池」对「一次性箱池」）——
 * 同一页上同一个东西两个叫法，读的人会以为那是两种不同的类型。
 *
 * 放在词汇表里而不是某个组件里：这个文件**没有任何依赖**，
 * 所以服务端组件、客户端组件、纯逻辑层都引得动它。
 */
export const MAIL_DOMAIN_KIND_LABEL: Record<MailDomainKind, string> = {
  owned: "有主域名",
  temp: "一次性箱池",
  reserved: "靓号池",
  admin: "只有管理员能开",
  blocked: "封禁",
};

/** 靓号档位，决定年租价。手工标，不做算法 —— 「哪个域名算好」是审美判断 */
export const MAIL_DOMAIN_TIERS = ["s", "a", "b"] as const;
export type MailDomainTier = (typeof MAIL_DOMAIN_TIERS)[number];

export const MAIL_DOMAIN_STATUSES = ["pending", "active", "paused", "retired"] as const;

/**
 * 四种箱子。
 *
 * `burner` 和 `temp` 的差别不只是时间长短：
 *   burner 不占槽位、24 小时、随机或长前缀 —— 它必须**零摩擦**
 *   temp   占槽位、30 天、自选前缀 —— 它是一个「地址」，不是一次动作
 * 合成一个 kind 靠 `expires_at` 区分的话，「还剩几个槽位」
 * 这个判断就要在每处重新写一遍 `if (ttl > 1 天)`。
 */
export const MAIL_BOX_KINDS = ["alias", "burner", "temp", "reserved"] as const;
export type MailBoxKind = (typeof MAIL_BOX_KINDS)[number];

export const MAIL_BOX_STATUSES = [
  "active",
  /** 配额满了，拒收中 */
  "full",
  /** 长期箱过期后的宽限期：地址仍归你，但别人抢不走 */
  "grace",
  "expired",
  "disabled",
  "revoked",
] as const;
export type MailBoxStatus = (typeof MAIL_BOX_STATUSES)[number];

/** 还占着地址的状态。地址唯一性只在这些之间成立 */
export const MAIL_BOX_ALIVE_STATUSES = ["active", "full", "grace", "disabled"] as const;

export const MAIL_SLOT_SOURCES = ["level", "purchase", "grant"] as const;

export const MAIL_INGRESS_VERDICTS = [
  "accepted",
  /** RCPT 阶段就拒了（地址不存在、域名封禁） */
  "rejected",
  /** 收下了但没落盘（配额满、频率超限） */
  "dropped",
  "quarantined",
] as const;
export type MailIngressVerdict = (typeof MAIL_INGRESS_VERDICTS)[number];

/** 禁用词的四种匹配方式，沿用 `sensitive_words` 那一套 */
export const MAIL_BANWORD_KINDS = ["exact", "prefix", "contains", "regex"] as const;
export type MailBanwordKind = (typeof MAIL_BANWORD_KINDS)[number];

export const MAIL_BLOCK_SCOPES = ["global", "domain", "box"] as const;
