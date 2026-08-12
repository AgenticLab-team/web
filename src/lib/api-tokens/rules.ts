/**
 * 开放 API 的令牌规则。纯函数，不碰数据库、不碰网络。
 *
 * ═════════════════════════════════════════
 * 这是全站唯一一处「拿到一串字符就能替人做事」的东西
 * ═════════════════════════════════════════
 *
 * 别的入口都要过登录会话 —— 会话有设备、有 IP、有过期、能一键下线。
 * 令牌没有这些：它就是一串字符，抄到哪里都能用。
 *
 * 所以这个文件里的每一条限制都不是「防御性设计」，
 * 而是在补会话本来就有、令牌没有的那部分。
 *
 * ═════════════════════════════════════════
 * 最要紧的一条：`groups:send` 会往一千六百人的群里发东西
 * ═════════════════════════════════════════
 *
 * 而且发出来的**署名是机器人**，不是持有令牌的那个人 ——
 * 也就是说令牌泄漏的后果不由泄漏者承担，由这个社区承担。
 *
 * 因此它单独成一个 scope、默认不给、单独限流、每一条都留痕。
 */

/**
 * 令牌前缀。
 *
 * 有前缀才能在日志、issue、聊天记录里**一眼认出这是一把钥匙** ——
 * GitHub 把 `ghp_` 加进去之后，扫描器的召回率是数量级的提升。
 * 一串没有前缀的随机字符，粘在群里没有人会觉得需要撤销。
 */
export const TOKEN_PREFIX = "al_";

/** 随机部分的字节数。32 字节 = 256 位，够了 */
export const TOKEN_BYTES = 32;

/**
 * 明文里保留给界面看的那几位。
 *
 * 列表上要能回答「我撤销的是哪一把」。只显示名字不够 ——
 * 人给令牌起的名字经常是「测试」「新的」「1」。
 */
export const VISIBLE_CHARS = 6;

export const SCOPES = [
  {
    key: "me:read",
    label: "读我自己的资料",
    detail: "昵称、积分、等级、称号、通知列表",
    danger: 0,
  },
  {
    key: "me:write",
    label: "改我自己的资料",
    detail: "改昵称、简介、技能标签、隐私开关",
    danger: 1,
  },
  {
    key: "groups:read",
    label: "读我所在的群",
    detail: "群列表、成员名册、聊天记录 —— 只限你自己在的群",
    danger: 1,
  },
  {
    key: "groups:send",
    label: "往我所在的群发消息",
    /*
     * 说清楚两件人最容易想错的事：
     *   · 发出来署名是机器人，不是他自己
     *   · 所以泄漏的后果落在整个社区身上
     */
    /*
     * 这几行是**直接显示在界面上的**，所以不能带 markdown 记号 ——
     * 界面不会渲染它们，只会原样把星号打出来。
     * （tests/ui-text.test.ts 盯的是 .tsx，这里是数据文件，扫不到。）
     */
    detail:
      "发出来的消息署名是群里那个机器人，不是你。" +
      "令牌泄漏意味着别人能用机器人的身份在群里说话 —— 这一项默认不给",
    danger: 2,
  },
] as const;

export type ScopeKey = (typeof SCOPES)[number]["key"];

export const SCOPE_KEYS: readonly ScopeKey[] = SCOPES.map((s) => s.key);

/** 危险级 ≥2 的 scope：授予时要单独确认，且不能默认勾上 */
export const DANGEROUS_SCOPES: readonly ScopeKey[] = SCOPES.filter((s) => s.danger >= 2).map(
  (s) => s.key,
);

export function isScopeKey(value: unknown): value is ScopeKey {
  return typeof value === "string" && (SCOPE_KEYS as readonly string[]).includes(value);
}

/**
 * 把客户端送上来的 scope 列表收拾干净。
 *
 * 认不出的**直接丢掉而不是报错**：上游加了新 scope、而这个版本还不认识时，
 * 报错会让整个请求失败；丢掉只是少一项权限 —— 少给永远比多给安全。
 */
export function normalizeScopes(raw: unknown): ScopeKey[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<ScopeKey>();
  for (const item of raw) if (isScopeKey(item)) seen.add(item);
  // 按声明顺序排，列表和审计里读起来才稳定
  return SCOPE_KEYS.filter((k) => seen.has(k));
}

export interface TokenShape {
  /** 完整明文，只在创建时出现一次 */
  plaintext: string;
  /** 存进库的那几位明文，用来在列表上认人 */
  visible: string;
}

/**
 * 从随机字节拼出令牌。
 *
 * 用 base64url 而不是 hex：同样的熵短三分之一，而这串东西
 * 是要被复制粘贴的 —— 长度直接影响它有多难用。
 */
export function formatToken(bytes: Uint8Array): TokenShape {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const body = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const plaintext = `${TOKEN_PREFIX}${body}`;
  return { plaintext, visible: body.slice(0, VISIBLE_CHARS) };
}

/** 形状对不对。对不上就**根本不必去查库** —— 省一次查询，也少一条时序信息 */
export function looksLikeToken(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value.startsWith(TOKEN_PREFIX)) return false;
  const body = value.slice(TOKEN_PREFIX.length);
  // base64url 编码 32 字节是 43 个字符
  return /^[A-Za-z0-9_-]{43}$/.test(body);
}

/**
 * 从 `Authorization` 头里取令牌。
 *
 * 只认 `Bearer`。允许 `?token=` 这种查询参数的话，令牌会进
 * 访问日志、Referer 头和浏览器历史 —— 那是三个我们控制不了的地方。
 */
export function tokenFromHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

/* ── 限流 ──────────────────────────────────────────────── */

/**
 * 发消息的**每令牌**配额。
 *
 * ⚠️ 上游的额度是 **20 条/分钟、200 条/小时，而且全站共用一把 key**。
 * 也就是说：所有成员的令牌、站长的群发、以及告警投递，
 * 抢的是同一个池子。
 *
 * 不给单个令牌设上限的话，一个人写错一个循环就能把额度吃干 ——
 * 那时候**站长发不出公告，而且告警也发不出来**，
 * 也就是说「出事了没人知道」和「出事」会同时发生。
 *
 * 所以每把令牌的上限定得远低于全站额度，剩下的留给公告和告警。
 */
export const SEND_LIMIT = {
  perMinute: 3,
  perHour: 20,
  perDay: 60,
} as const;

export interface SendLimits {
  perMinute: number;
  perHour: number;
  perDay: number;
}

/**
 * 把「这条授权自己的额度」和全局额度合起来。
 *
 * ═════════════════════════════════════════
 * **只能收紧，不能放宽**
 * ═════════════════════════════════════════
 *
 * 两份额度保的是两件不同的事：
 *   · 全局那份保**全站不被一个人吃干**（上游 20 条/分钟全站共用，
 *     还要给站长公告和系统告警留余量）
 *   · 授权那份保**单个群不被一个人刷屏**
 *
 * 所以取两者更严的那个。允许放宽的话，在授权上填一个大数
 * 就能绕过那条「给公告和告警留余量」的底线 —— 而那条底线的
 * 失效方式是「出事了没人知道」和「出事」同时发生。
 *
 * 传 null / undefined = 那一档跟着全局走。
 */
export function effectiveLimits(
  grant?: { perMinute?: number | null; perHour?: number | null; perDay?: number | null } | null,
): SendLimits {
  const pick = (own: number | null | undefined, global: number) =>
    typeof own === "number" && own >= 0 ? Math.min(own, global) : global;
  return {
    perMinute: pick(grant?.perMinute, SEND_LIMIT.perMinute),
    perHour: pick(grant?.perHour, SEND_LIMIT.perHour),
    perDay: pick(grant?.perDay, SEND_LIMIT.perDay),
  };
}

export interface SendUsage {
  minute: number;
  hour: number;
  day: number;
}

export interface LimitVerdict {
  allowed: boolean;
  /** 拒绝时给调用方看的话；通过时为 null */
  error: string | null;
  /** 建议多少秒后再试 —— 直接放进 Retry-After */
  retryAfterSeconds: number | null;
}

/**
 * 还能不能再发一条。
 *
 * 三个窗口一起判，报最先撞上的那个：只说「超限了」的话，
 * 调用方不知道该等一分钟还是等一天。
 */
export function checkSendLimit(usage: SendUsage, limits: SendLimits = SEND_LIMIT): LimitVerdict {
  if (usage.minute >= limits.perMinute) {
    return { allowed: false, error: `每分钟最多 ${limits.perMinute} 条`, retryAfterSeconds: 60 };
  }
  if (usage.hour >= limits.perHour) {
    return { allowed: false, error: `每小时最多 ${limits.perHour} 条`, retryAfterSeconds: 600 };
  }
  if (usage.day >= limits.perDay) {
    return { allowed: false, error: `每天最多 ${limits.perDay} 条`, retryAfterSeconds: 3600 };
  }
  return { allowed: true, error: null, retryAfterSeconds: null };
}

/* ── 消息内容 ──────────────────────────────────────────── */

/** 一条最长多少字。上游更宽，但太长的消息在群里就是刷屏 */
export const MAX_MESSAGE_CHARS = 500;

/** 站点域名，署名里用 */
export const SITE_HOST = "AgenticLab.sh";

/**
 * 代发署名。**发出去的每一条都必须带**。
 *
 * ═════════════════════════════════════════
 * 它解决的是一个身份问题，不是礼貌问题
 * ═════════════════════════════════════════
 *
 * 消息是机器人账号发出去的，所以群里看到的是机器人在说话 ——
 * **谁让它说的，群里的人一个字都看不到**。
 *
 * 那意味着两件坏事：
 *   · 有人借机器人的嘴说话，而责任落在机器人（也就是站长）身上
 *   · 出事之后要靠翻我们自己的库才说得清是谁，
 *     而群里的当事人当时根本无从判断
 *
 * 加上这一行之后，「这句话是谁的」在**群里当场**就成立，
 * 不必等谁去查后台。
 *
 * ─────────────────────────────────────────
 * 为什么是一个函数而不是一段模板
 * ─────────────────────────────────────────
 *
 * 因为它必须**没有办法被绕过**：发送那条路上只有一处拼正文，
 * 而那一处只接受这个函数的输出。写成「记得在调用前拼一下」的话，
 * 迟早有第二个调用点忘记 —— 而忘记的那一次不会报错，
 * 只会安静地发出一条没有署名的消息。
 */
export function withAttribution(text: string, senderName: string): string {
  const who = senderName.trim() || "某位成员";
  return `${text}\n本消息由「${who}」使用 ${SITE_HOST} 代发`;
}

/**
 * 署名那一行本身要占多少字。
 *
 * 正文上限要**扣掉**它 —— 不扣的话，一条刚好 500 字的正文
 * 加上署名会超过上游的长度限制，而失败原因会显示成
 * 「上游拒绝」，没有人能想到是署名撑破的。
 */
export function attributionCost(senderName: string): number {
  return [...withAttribution("", senderName)].length;
}

export interface MessageVerdict {
  ok: boolean;
  text: string;
  error: string | null;
}

/**
 * 要发的这段文字能不能发。
 *
 * **不做敏感词判断** —— 那一套在 `lib/moderation` 里，
 * 由调用方在这之后过一遍。这里只管形状。
 */
export function validateMessage(raw: unknown, senderName?: string): MessageVerdict {
  if (typeof raw !== "string") {
    return { ok: false, text: "", error: "text 必须是字符串" };
  }
  const text = raw.trim();
  if (text.length === 0) {
    return { ok: false, text: "", error: "不能发空消息" };
  }
  /*
   * 上限要为署名让出位置：署名是**一定会加上去**的，
   * 不预留的话，一条刚好压线的正文会在上游那边被拒，
   * 而错误信息是「上游拒绝」—— 没有人会想到是署名撑破的。
   */
  const budget = MAX_MESSAGE_CHARS - attributionCost(senderName ?? "");
  if ([...text].length > budget) {
    return { ok: false, text: "", error: `最长 ${budget} 个字（另有一行代发署名）` };
  }
  return { ok: true, text, error: null };
}
