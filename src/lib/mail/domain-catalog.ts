/**
 * 手上这 100 个域名各是什么。纯数据 + 纯函数，不碰数据库。
 *
 * ═════════════════════════════════════════
 * 为什么归类要写在代码里，而不是只灌一次库
 * ═════════════════════════════════════════
 *
 * 因为**「这个域名为什么是这一类」是要能被追问的**。
 * 只灌库的话，半年后有人问「githubusercontent 怎么在封禁里」，
 * 答案在某次 INSERT 里，谁都翻不到。
 *
 * 种子按这份清单**只补不改**：管理员在后台改过的分类不会被下次启动重置
 * （和 `DEFAULT_SETTINGS` 同一个规矩）。
 *
 * 归属那 28 个不在这里定 —— 它们从 `activity_applications` 认领，
 * 见 `seed-domains.ts`。写死一份人名清单是把一份会变的事实抄成了常量。
 */

import type { MailDomainKind, MailDomainTier } from "@/lib/mail/kinds";

export type DomainKind = MailDomainKind;
export type DomainTier = MailDomainTier;

export interface CatalogEntry {
  /** U 标签（人看的形态）。中文域名这里是中文 */
  domain: string;
  kind: DomainKind;
  /**
   * 「看起来是给某个人准备的，但对不上现有的主」。
   *
   * 种子会拿它去跑一遍归属匹配（`claim-matching.ts`）——
   * 匹配上就转成 `owned` 并认到那个人头上，匹配不上就**留在 `kind` 那一格**。
   *
   * 为什么不直接写死一份「域名 → 人」的清单：那等于把一份会变的事实
   * 抄成常量，而且**「凭什么是他的」就答不上了**。匹配是算出来的，
   * 理由写进 `note` 和审计。
   */
  pendingOwner?: boolean;
  tier?: DomainTier;
  /** 为什么是这一类 —— 封禁和特殊开关那几个必须写 */
  note?: string;
  /** 覆盖默认开关。不写就按 kind 的默认值来 */
  allowCustomLocal?: boolean;
  allowClaim?: boolean;
  inRandomRotation?: boolean;
}

/* ── ① 已有主（28）──────────────────────────────────────────
 *
 * 27 个来自域名活动第一期的登记，加上 niuniu869 ——
 * 那位登记的 niuniu.icu 早在 2023 年就被别人注册了（RDAP 查得到），
 * 站长另买了这个作为替代。归属从 activity_applications 认领。
 */
const OWNED_FROM_ACTIVITY = [
  "aetherstudio.icu",
  "agenthing.icu",
  "ai-talkshow.icu",
  "cjlworks.icu",
  "codetics.icu",
  "corvusamuse.icu",
  "gptagent.icu",
  "ificanfly.icu",
  "iseeyouin.icu",
  "jiubeixin.icu",
  "jokerai.icu",
  "kizunerwe.icu",
  "layopc.icu",
  "lopleec.icu",
  "lts4ai.icu",
  "md5523.icu",
  "meinianda.icu",
  "neurolancer.icu",
  "shipowner.icu",
  "tech10.icu",
  "techcheng.icu",
  "tianzzi.icu",
  "tripfz-jmr.icu",
  "vistago.icu",
  "yigeren.icu",
  "yintins-01.icu",
  "zennon.icu",
] as const;

/**
 * 认领失败后的替代品。
 *
 * key 是当初登记的域名（`activity_applications.normalized_key`），
 * value 是实际买到的那个。这张表让「谁该拿到 niuniu869」有据可查，
 * 而不是靠一次手工指派。
 */
export const SUBSTITUTES: Readonly<Record<string, string>> = {
  "niuniu.icu": "niuniu869.icu",
};

/**
 * 站长**人工确认**的配对：左边这个域名，和右边那个已认领的域名是同一个人的。
 *
 * ═════════════════════════════════════════
 * 为什么不是去放松匹配器
 * ═════════════════════════════════════════
 *
 * 这四个匹配器都挡下来了，而它挡得有道理：
 *
 *   `lay621` ↔ `layopc`     —— 共享的核心串是 `lay`，**只有 3 个字符**，
 *                              它同样出现在 relay、display 里
 *   `cjl2726` ↔ `cjlworks`  —— 同上，`cjl` 3 个字符
 *   `10kjs` ↔ `tech10`      —— 要认出「科技说 → kjs」得会拼音首字母
 *   `techerng` ↔ `techcheng` —— 改的是中间的字母，不是加减一段
 *
 * 把规则放松到能捞起这四个，就会顺带把别人的域名也判错 ——
 * 而判错的代价是把 A 的域名发给 B。所以规则不动，
 * **人工确认的走这张表**，理由记成「站长确认」。
 *
 * ⚠ 这里写的是**域名 → 域名**，不是域名 → 人名。
 * 人仍然从库里查（谁拥有右边那个），所以「凭什么是他的」照样答得上，
 * 而且那个人换了账号、改了昵称都不影响。
 */
export const CONFIRMED_PAIRS: Readonly<Record<string, string>> = {
  "lay621.icu": "layopc.icu",
  "cjl2726.icu": "cjlworks.icu",
  "10kjs.icu": "tech10.icu",
  "techerng.icu": "techcheng.icu",
};

/** 站长自己的两个。走和别人完全一样的 `owned` 路径 —— 见下面那段注释 */
export const OWNER_DOMAINS = ["muran.icu", "jiangmuran.icu"] as const;

/**
 * 这一百个域名的到期日：**2027-08-08**（站长 8-13 给的）。
 *
 * 写成常量而不是让人一个个填，因为它们是同一批买的、同一天到期。
 * 种子**只填空、不覆盖** —— 后台改过的日期不会被下次启动重置。
 *
 * 为什么这个数字要紧：空的到期日**不触发任何告警**，
 * 也就是说没填的比快到期的还危险 —— 会在零预警的情况下过期，
 * 然后挂在上面的所有邮箱一起消失，而表现只是「邮件不再来了」。
 *
 * 用 UTC 正午而不是零点：不同时区看到的日期会差一天，
 * 而「还剩几天」是拿来做告警判定的。
 */
export const DOMAIN_EXPIRES_AT = Date.UTC(2027, 7, 8, 12, 0, 0);

export const CATALOG: readonly CatalogEntry[] = [
  ...OWNED_FROM_ACTIVITY.map((domain): CatalogEntry => ({ domain, kind: "owned" })),
  { domain: "niuniu869.icu", kind: "owned", note: "niuniu.icu 抢注失败后的替代品" },

  /*
   * 站长自己的两个，`kind = owned`，指给站长的账号。
   *
   * 不单独造一个「站长自用」类别是有意的：**自有域名那条路径的
   * 第一个用户就是站长本人**。catch-all 没生效、前缀发现没跑起来、
   * DNS 灯是错的 —— 这些他当天就会撞上，而不是等某个拿到域名的人来报。
   */
  { domain: "muran.icu", kind: "owned", note: "站长本人" },
  { domain: "jiangmuran.icu", kind: "owned", note: "站长本人" },

  /* ── ② 看起来是给具体人的（22）────────────────────────────
   *
   * 站长 8-13 定的规矩：**能匹配上就归那个人，匹配不上就进公共池**。
   *
   * 匹配跑在种子里（`claim-matching.ts`），证据只认两种：
   * 昵称，以及已认领域名的变体。核心串至少 5 个字符 ——
   * 判错的代价是不对称的：判不出来只是一次沟通，
   * **判错了是把 A 的域名发给了 B**。
   *
   * 匹配不上时落在 `reserved`（靓号池）而不是一次性池：
   * 靓号要花积分、由一个**认得出是谁**的成员申领、全程留痕；
   * 而一次性池是匿名的 24 小时地址。这些名字里有不少像真人姓名，
   * 两者的差别在那种情况下很要紧。
   */
  ...(
    [
      ["ashipowner.icu", "像是 shipowner.icu 主人的第二个"],
      ["tripfzjmr.icu", "像是 tripfz-jmr.icu 的去连字符版"],
      ["yintins.icu", "像是 yintins-01.icu 的干净版"],
      ["carleight.icu", "像是某人的名字"],
      ["carleightwu.icu", "同上，两个应该是同一个人"],
      ["borancui.icu", "像是人名"],
      ["ryanzhu.icu", "像是人名"],
      ["sunyuchen.icu", "像是人名"],
      ["daiyu1.icu", "像是个人 ID"],
      ["lay621.icu", "像是个人 ID"],
      ["cjl2726.icu", "像是个人 ID"],
      ["z091127.icu", "像是个人 ID"],
      ["tatumisin.icu", "像是个人 ID"],
      ["cacinie.icu", "像是个人 ID"],
      ["techerng.icu", "像是个人 ID"],
      ["msadream.icu", "像是个人 ID"],
      ["qific.icu", "像是个人 ID"],
      ["awmcap.icu", "像是个人 ID"],
      ["m78ai.icu", "像是个人 ID"],
      ["10kjs.icu", "拿不准"],
      ["unknownuserfrommars.icu", "拿不准"],
      /*
       * 站长 8-13：扔进可以申请的池子。
       *
       * ⚠ CLIProxyAPI 是真实存在的开源项目。放在**靓号池**而不是一次性池
       * 至少意味着拿到它的是一个认得出是谁、花了积分、全程留痕的成员，
       * 而不是一个匿名的 24 小时地址 —— 万一那个项目的作者找上门，
       * 我们答得出是谁在用。
       */
      ["cliproxyapi.icu", "⚠ CLIProxyAPI 是真实存在的开源项目，站长决定放开申请"],
    ] as const
  ).map(
    ([domain, note]): CatalogEntry => ({
      domain,
      kind: "reserved",
      tier: "b",
      pendingOwner: true,
      note: `原判「${note}」—— 匹配不上就留在靓号池`,
    }),
  ),

  /* ── ③ 管理员专用（11）────────────────────────────────────
   *
   * 站长 8-14：**MX 配上，但不进池子，只有管理员能用。**
   *
   * 这些域名注册下来是为了不让别人注册。原本打算连 MX 都不配（`blocked`），
   * 改成 `admin` 之后多了一件事：**看得见有人在试探** ——
   * 发到 `security@某商标.icu` 的每一次投递都会进 `mail_ingress_log`，
   * 而没有 MX 的话那些尝试连痕迹都不留。
   *
   * 风险没有变大：危险的从来不是收信，是**身份**（拿这种地址去发信、
   * 去做域名所有权验证）。而发信全站默认关死，
   * 开地址又只有管理员做得到、每次进 audit。
   */
  { domain: "githubusercontent.icu", kind: "admin", note: "商标：raw.githubusercontent.com 是所有开发者的肌肉记忆，最危险的一个" },
  { domain: "huggingface.icu", kind: "admin", note: "商标：Hugging Face" },
  { domain: "airtable.icu", kind: "admin", note: "商标：Airtable" },
  { domain: "opencart.icu", kind: "admin", note: "商标：OpenCart，真实开源电商项目" },
  { domain: "openreview.icu", kind: "admin", note: "商标：OpenReview.net，真实学术平台" },
  { domain: "moonshot48.icu", kind: "admin", note: "商标：月之暗面 Moonshot AI" },
  { domain: "claudex.icu", kind: "admin", note: "商标：Anthropic Claude" },
  { domain: "bilibill.icu", kind: "admin", note: "商标：bilibili 的形近拼写，仿冒域名的典型形态" },
  { domain: "dgxspark.icu", kind: "admin", note: "商标：NVIDIA DGX Spark" },
  { domain: "adventurex.icu", kind: "admin", note: "商标：AdventureX" },
  { domain: "余承东.icu", kind: "admin", note: "真人姓名（华为高管）。姓名权见民法典 1012–1014" },

  /* ── ④ 靓号池（22）────────────────────────────────────────
   *
   * **不跑一次性箱** —— 这是它唯一真正卖的东西：
   * 你花 400 分买的地址，不会因为别人在同一个域名上注册了一百个账号
   * 而被某个网站拒收。名字好听只是附带的。
   */
  ...(
    [
      ["tsuki.icu", "s"],
      ["seeus.icu", "s"],
      ["icubed.icu", "s"],
      ["spotme.icu", "s"],
      ["bluecat.icu", "s"],
      ["opencode.icu", "a"],
      ["watchdog.icu", "a"],
      ["filedrop.icu", "a"],
      ["fastnote.icu", "a"],
      ["typeless.icu", "a"],
      ["canusee.icu", "a"],
      ["kandian.icu", "a"],
      ["quickview.icu", "a"],
      ["snapview.icu", "a"],
      ["visionai.icu", "b"],
      ["deepvision.icu", "b"],
      ["quantwhale.icu", "b"],
      ["dailyplan.icu", "b"],
      ["takemyhand.icu", "b"],
      ["takemehand.icu", "b"],
      ["aicam.icu", "b"],
      ["aiclip.icu", "b"],
    ] as const
  ).map(([domain, tier]): CatalogEntry => ({ domain, kind: "reserved", tier })),

  /* ── ⑤ 一次性池（14）──────────────────────────────────────
   *
   * 挑选标准是**这个域名要能被牺牲掉**：一次性邮箱迟早会被
   * 某些网站列进黑名单（这是这类服务的宿命），
   * 被拖下水的应该是这十四个，不是 tsuki.icu。
   */
  { domain: "rickroll.icu", kind: "temp" },
  { domain: "dontgoto.icu", kind: "temp" },
  { domain: "icudoctor.icu", kind: "temp" },
  { domain: "orange-public.icu", kind: "temp" },
  { domain: "trinity3.icu", kind: "temp" },
  { domain: "northwind.icu", kind: "temp" },
  { domain: "agibar.icu", kind: "temp" },
  {
    domain: "pneumonoultramicroscopicsilicovolcanoconiosis.icu",
    kind: "temp",
    note: "49 字符。没人会想长期用它，而它确实能收信 —— 一次性池里这是加分项",
  },

  /*
   * 中文域名：**默认不进随机轮换**。
   *
   * 很多网站的注册表单直接拒收 IDN 邮箱地址，而一次性箱的全部用途
   * 就是去那些表单里注册。默认发一个用不了的地址，
   * 是这个功能最糟的第一印象。想用的人可以显式选它。
   */
  { domain: "我真的特别特别特别特别特别想你.icu", kind: "temp", inRandomRotation: false, note: "IDN，不进随机轮换" },
  { domain: "云上耀斑.icu", kind: "temp", inRandomRotation: false, note: "IDN，不进随机轮换" },

  /*
   * 站长 8-13 决定从封禁挪进一次性池的四个。
   *
   * 放一次性池比放靓号池风险小得多：24 小时销毁、只收不发、
   * 前缀有最短长度、还过禁用词表。但这四个额外关掉两件事 ——
   * **自选前缀**和**申领**：
   *   · 自选前缀 + 这几个域名，组合出来的地址才是有杀伤力的那种；
   *     随机的 12 位串没有这个问题
   *   · 一个 24 小时就消失的地址，和一个署着名字挂一年的地址，性质不一样
   */
  { domain: "马嘉祺.icu", kind: "temp", allowCustomLocal: false, allowClaim: false, inRandomRotation: false, note: "真人姓名 + IDN：只发随机前缀，不给申领" },
  { domain: "华立.icu", kind: "temp", allowCustomLocal: false, allowClaim: false, inRandomRotation: false, note: "公司名 + IDN：只发随机前缀，不给申领" },
  { domain: "teensintimes.icu", kind: "temp", allowCustomLocal: false, allowClaim: false, note: "语义敏感：只发随机前缀，不给申领" },
  { domain: "camhub.icu", kind: "temp", allowCustomLocal: false, allowClaim: false, note: "语义敏感：只发随机前缀，不给申领" },
  // 站长 8-13：babycam 跟 camhub 一起进一次性池，约束也一样
  { domain: "babycam.icu", kind: "temp", allowCustomLocal: false, allowClaim: false, note: "语义敏感：只发随机前缀，不给申领" },
];

export interface DomainFlags {
  allowBurner: boolean;
  allowClaim: boolean;
  allowCustomLocal: boolean;
  inRandomRotation: boolean;
  catchAll: boolean;
}

/** 每一类的默认开关。逐个域名可以覆盖（见 CatalogEntry） */
export const DEFAULT_FLAGS: Readonly<Record<DomainKind, DomainFlags>> = {
  // 域名是他的，前缀没人跟他抢 —— catch-all 开着才是「任意别名」的真意思
  owned: { allowBurner: false, allowClaim: true, allowCustomLocal: true, inRandomRotation: false, catchAll: true },
  temp: { allowBurner: true, allowClaim: true, allowCustomLocal: true, inRandomRotation: true, catchAll: false },
  // ★ allowBurner 恒为 false —— 这是靓号值钱的全部原因
  reserved: { allowBurner: false, allowClaim: true, allowCustomLocal: true, inRandomRotation: false, catchAll: false },
  /*
   * 收信，但一个口子都不对普通成员开 —— 只有管理员能在上面开地址
   * （走 `bypassLimits`，每次进 audit 和 mail_events）。
   */
  admin: { allowBurner: false, allowClaim: false, allowCustomLocal: false, inRandomRotation: false, catchAll: false },
  blocked: { allowBurner: false, allowClaim: false, allowCustomLocal: false, inRandomRotation: false, catchAll: false },
};

export function defaultsFor(kind: DomainKind): DomainFlags {
  return DEFAULT_FLAGS[kind];
}

/** 一条目录项最终的开关。显式写的覆盖类别默认值 */
export function resolveFlags(entry: CatalogEntry): DomainFlags {
  const base = defaultsFor(entry.kind);
  return {
    ...base,
    allowClaim: entry.allowClaim ?? base.allowClaim,
    allowCustomLocal: entry.allowCustomLocal ?? base.allowCustomLocal,
    inRandomRotation: entry.inRandomRotation ?? base.inRandomRotation,
  };
}

/**
 * 中文域名转 A 标签。
 *
 * 用 `URL` 而不是引一个 punycode 库：Node 的 URL 解析器内置了 IDNA，
 * 而多引一个依赖来做一件标准库已经做对的事，是以后要维护的东西。
 *
 * ⚠️ 转不动时**返回原样并让调用方报错**，不是静默通过 ——
 * 一个转错的域名会表现成「这个域名收不到信」，而没有任何报错。
 */
export function toPunycode(domain: string): string {
  const lower = domain.trim().toLowerCase();
  if (!lower) return lower;
  try {
    const url = new URL(`http://${lower}`);
    return url.hostname;
  } catch {
    return lower;
  }
}

/** ASCII 域名转出来应该和自己相同；中文的应该以 xn-- 开头 */
export function isPunycodeSane(domain: string, punycode: string): boolean {
  if (!/^[a-z0-9.-]+$/.test(punycode)) return false;
  const ascii = /^[a-z0-9.-]+$/.test(domain.toLowerCase());
  return ascii ? punycode === domain.toLowerCase() : punycode.includes("xn--");
}
