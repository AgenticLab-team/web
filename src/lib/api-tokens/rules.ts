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

/**
 * ═════════════════════════════════════════
 * 分多细：按「泄漏了会损失什么」，不按「它是哪个页面」
 * ═════════════════════════════════════════
 *
 * 终端客户端要覆盖网页上的每一个板块，最直觉的做法是一个板块一个
 * scope —— 积分一个、商店一个、活动一个、成员一个、雷达一个……
 * 那会有二十来个，而它们**全部要显示在同意页上让人逐条读**。
 *
 * 一页二十条勾选框的实际效果是没有人读，全部点「同意」——
 * 也就是说分得越细，`groups:send` 那一条被看见的概率越低，
 * 而那是唯一一条泄漏后果由整个社区承担的。
 *
 * 所以判据是**损失**：读公开的东西（榜单、项目目录、活动、商店橱窗）
 * 归一条；花掉我的积分归一条；能替我在群里说话单独一条。
 * 同一个损失量级的合并，不同量级的拆开。
 */
export const SCOPES = [
  {
    key: "me:read",
    label: "读我自己的资料",
    /*
     * 「我的东西」是一个整体：收藏夹、草稿箱、关注列表、订单记录，
     * 泄漏的后果都是同一件事 —— 别人知道了我私下在看什么。
     * 拆成四条不会让任何人更安全，只会让同意页更长。
     */
    detail: "昵称、积分、等级、称号、收藏夹、草稿箱、关注列表、订单",
    danger: 0,
  },
  {
    key: "me:write",
    label: "改我自己的资料、打卡、收藏",
    detail: "改昵称简介技能标签、隐私开关、每日打卡、收藏与关注、存草稿、自荐项目",
    danger: 1,
  },
  {
    key: "community:read",
    label: "读社区里公开的那些",
    /*
     * 单独于 `me:read`：这一条读的是**别人**。
     * 归在一起的话，一个只想读自己积分的脚本会顺手拿到
     * 整个成员目录 —— 而成员目录里有一千多个人的主页。
     */
    detail: "成员目录与他人主页、排行榜、项目目录、活动列表、商店橱窗、称号图鉴",
    danger: 0,
  },
  {
    key: "economy:write",
    label: "花我的积分",
    /*
     * 从 `me:write` 里拆出来的唯一理由：**它花的是真东西**。
     * 改昵称错了可以改回来，积分买完了就没了 ——
     * 「能改我的资料」和「能花光我的积分」不该共用一个勾。
     */
    detail: "在商店下单、给帖子打赏、发悬赏、用补签卡 —— 都会真的扣掉积分",
    danger: 1,
  },
  {
    key: "activities:write",
    label: "替我报名活动",
    detail: "报名、退出、提交作品 —— 有名额和资格判定，和网页上完全一样",
    danger: 1,
  },
  {
    key: "notifications:read",
    label: "读我的通知",
    /*
     * 通知不是「一串标题」：@ 的上下文、回复的正文摘要都在里面，
     * 也就是说它能读到**别人对我说的私下的话**。所以它不归 `me:read`，
     * 而且危险级是 1 不是 0。
     */
    detail: "通知列表与实时推送流 —— 里面带着 @ 我的那条消息的正文",
    danger: 1,
  },
  {
    key: "notifications:write",
    label: "标记已读、改通知偏好",
    detail: "把通知标成已读、开关某一类通知。**读不到内容**",
    danger: 0,
  },
  {
    key: "groups:read",
    label: "读我所在的群",
    detail:
      "群列表、成员名册、聊天记录、按天回看、资源库、关键词雷达、群统计 —— 只限你自己在的群",
    danger: 1,
  },
  {
    key: "forum:read",
    label: "读论坛",
    detail: "帖子列表、帖子正文和回复 —— 只给你本来就看得到的那些",
    danger: 0,
  },
  {
    key: "forum:write",
    label: "以我的名义发帖和回复",
    /*
     * 论坛这一条比群消息轻，但也不是零风险：
     * 它写的是**署你名字**的内容 —— 而群消息署的是机器人的名字。
     * 所以两者的「泄漏之后会怎样」完全不同，说明也要分开写。
     */
    detail:
      "发出来的帖子和回复署的是你的名字。版块权限、等级门槛、敏感词、" +
      "发帖频率限制和网页上完全一样 —— 令牌不是一条绕开规则的近路",
    danger: 1,
  },
  {
    key: "mail:burner",
    label: "开一次性邮箱并读它收到的信",
    /*
     * ═════════════════════════════════════════
     * 为什么它和 mail:read 必须是两个 scope
     * ═════════════════════════════════════════
     *
     * 一次性箱里装的是「我刚才在某个网站注册」这一件事，寿命 24 小时。
     * 而自有域名的收件箱里装的是这个人**真正在用的邮箱** ——
     * 一把泄漏的令牌读得到后者，等于把他在所有网站上的
     * 找回密码通道一起交出去。
     *
     * 而 API 的真实用途（注册脚本、测试、CI 里收个验证码）
     * **只需要前者**。合成一个 scope 的话，等于逼每个想自动化的人
     * 交出全部邮件 —— 于是安全的默认值变成「谁都别用」，
     * 而那不是安全，是把功能关掉。
     *
     * 还要再收窄一层：**只能读这把令牌自己开的箱子**。
     * 泄漏一把令牌的爆炸半径，就是它自己造出来的那几个地址。
     */
    detail:
      "只能开一次性邮箱、读这把令牌自己开的那几个箱子。" +
      "你在网页上开的箱子它看不到，你的自有域名和长期邮箱它也看不到",
    danger: 1,
  },
  {
    key: "mail:read",
    label: "读我所有的邮箱",
    /*
     * danger 2，和 groups:send 同一级，但危险的方向不同：
     * groups:send 泄漏后受害的是社区，这一个泄漏后受害的是持有人自己 ——
     * 而受害的方式是他所有第三方账号的找回密码通道一起被打开。
     */
    detail:
      "包括自有域名和长期邮箱里的每一封信。邮箱里有验证码和找回密码的链接，" +
      "所以这一项等于把你在别的网站上的账号一起交出去 —— 默认不给",
    danger: 2,
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
  {
    key: "admin:all",
    label: "以管理员身份操作后台",
    /*
     * ═════════════════════════════════════════
     * 为什么后台只有一个 scope，而不是三十个
     * ═════════════════════════════════════════
     *
     * 因为**真正的权限判定不在这里**。后台每一个动作仍然要过
     * `requireWritableAdmin("权限点")` 和 `can()`，也就是说
     * 这个 scope 决定的只有一件事：**这把令牌能不能走后台那扇门**。
     * 门后面能干什么，由这个人的身份组说了算，一条都不多。
     *
     * 按权限点拆成三十个 scope 的话，同意页会长到没人读（见上面那段），
     * 而且它们会和 `rbac/permissions.ts` 那张表分叉 ——
     * 一份权限清单维护两遍，第二份永远落后。
     *
     * 危险级 2：一把带这个的令牌泄漏，等于把后台交出去，
     * 而且**审计日志上仍然写着令牌主人的名字**。
     */
    detail:
      "能调后台接口。具体能做什么仍然由你的身份组决定，一条都不多。" +
      "但用它做的每一件事，审计日志上署的都是你的名字 —— 这一项默认不给",
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
