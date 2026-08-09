/**
 * 关键词匹配。纯函数。
 *
 * ─────────────────────────────────────────
 * 中英文的词边界完全不是一回事
 * ─────────────────────────────────────────
 *
 * 英文订阅「AI」，如果按子串匹配，会命中 said、chain、rain、maintain ——
 * 一天几百条，用户第二天就把整个雷达关掉了。所以 ASCII 词要卡词边界。
 *
 * 中文订阅「模型」，如果也卡词边界，一条都命中不了 ——
 * 中文本来就不用空格分词。所以 CJK 要按子串匹配。
 *
 * 同一个规则套两种语言，必然有一种是坏的。
 *
 * ─────────────────────────────────────────
 * 雷达真正的敌人是噪音
 * ─────────────────────────────────────────
 *
 * 一个订阅了「AI」的人一天收到两百条通知，他的应对不是精简关键词，
 * 是**把通知全关掉** —— 连带着那些他真正在意的也一起没了。
 *
 * 所以订阅之前先算一遍「过去七天这个词会响多少次」，
 * 太吵的当场拦下来。事后再让人后悔，代价是一个不再看通知的用户。
 */

import { dateKey } from "@/lib/time";

export const MAX_KEYWORDS_PER_USER = 10;
export const MIN_KEYWORD_LENGTH = 2;
export const MAX_KEYWORD_LENGTH = 24;

/** 一个词一天最多提醒几次 —— 超过就当天不再打扰，第二天重置 */
export const MAX_HITS_PER_DAY = 5;

/**
 * 七天内命中超过这个数就算太吵，默认拦下。
 *
 * 这个数字是拿生产数据校准的（2026-08，近七天 19,632 条可扫消息）：
 *
 *     AI      343      大模型  24
 *     Agent    91      MCP      4
 *     claude   67      RAG      1
 *
 * 一开始定的 40 会把「claude」「Agent」这种社群里真正想订阅的词
 * 一起挡掉 —— 而每天封顶 5 次已经把实际打扰量兜住了，
 * 真正需要拦的只有「AI」这种一天响五十次、通知内容完全随机的词。
 *
 * 所以拦的不是「会不会吵」，是**「这个词还能不能指向具体的东西」**。
 */
export const NOISY_THRESHOLD_7D = 150;

export function normalizeKeyword(raw: string): string {
  return raw.normalize("NFKC").replace(/[\s　]+/g, " ").trim();
}

/** 匹配用的键：大小写无关 */
export function keywordKey(raw: string): string {
  return normalizeKeyword(raw).toLowerCase();
}

export interface KeywordIssue {
  input: string;
  reason: string;
}

/**
 * 这个词能不能订阅。
 *
 * 单字符的 ASCII 词（a、x）会命中一切，必须拦；
 * 单个汉字（「的」「和」）同理 —— 所以最短两个字符。
 */
export function validateKeyword(raw: string): { ok: true; keyword: string } | { ok: false; reason: string } {
  const keyword = normalizeKeyword(raw);
  if (!keyword) return { ok: false, reason: "空的" };
  if (keyword.length < MIN_KEYWORD_LENGTH) {
    return { ok: false, reason: `太短了 —— 至少 ${MIN_KEYWORD_LENGTH} 个字，一个字会命中一切` };
  }
  if (keyword.length > MAX_KEYWORD_LENGTH) {
    return { ok: false, reason: `超过 ${MAX_KEYWORD_LENGTH} 个字` };
  }
  // 纯符号匹配不出东西，只会让人以为雷达坏了
  if (!/[\p{L}\p{N}]/u.test(keyword)) {
    return { ok: false, reason: "只有符号，匹配不到任何东西" };
  }
  return { ok: true, keyword };
}

/** 这个词是不是纯 ASCII（决定要不要卡词边界） */
export function isAsciiWord(keyword: string): boolean {
  return /^[\x20-\x7E]+$/.test(keyword);
}

/**
 * 一条消息里命中了这个词没有。
 *
 * ASCII 词卡词边界：订阅「AI」不该被 said / chain / maintain 命中。
 * 但 `\b` 在这里不能用 —— JS 的 `\b` 基于 `\w`，
 * 而「AI大模型」里 AI 后面是汉字，`\b` 认为那是边界，会命中；
 * 反过来「AI-agent」里的连字符也被认成边界。前者是我们想要的，
 * 后者也是。真正要排除的只有**两侧紧挨着 ASCII 字母或数字**的情况。
 */
export function matchesKeyword(content: string, keyword: string): boolean {
  if (!content || !keyword) return false;

  const haystack = content.toLowerCase();
  const needle = keywordKey(keyword);
  if (!needle) return false;

  if (!isAsciiWord(needle)) {
    // CJK：子串匹配 —— 中文本来就不用空格分词
    return haystack.includes(needle);
  }

  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return false;

    const before = index > 0 ? haystack[index - 1] : "";
    const after = haystack[index + needle.length] ?? "";
    if (!isAsciiWordChar(before) && !isAsciiWordChar(after)) return true;

    from = index + 1;
  }
}

/**
 * 下划线算词字符：`AI_agent` 是一个标识符，不该被「AI」命中 ——
 * 和 `GPT4` 不该被「GPT」命中是同一个道理。
 */
function isAsciiWordChar(char: string): boolean {
  return /^[a-z0-9_]$/.test(char);
}

/** 命中的位置，用来在通知里高亮 */
export function highlight(content: string, keyword: string, radius = 40): string | null {
  const haystack = content.toLowerCase();
  const needle = keywordKey(keyword);
  const index = haystack.indexOf(needle);
  if (index === -1) return null;

  const start = Math.max(0, index - radius);
  const end = Math.min(content.length, index + needle.length + radius);
  return (
    (start > 0 ? "…" : "") + content.slice(start, end).trim() + (end < content.length ? "…" : "")
  );
}

// ── 噪音控制 ────────────────────────────────────────────────

export type NoiseVerdict = "ok" | "busy" | "noisy";

export interface NoiseCheck {
  verdict: NoiseVerdict;
  hits7d: number;
  perDay: number;
  message: string;
}

/**
 * 订阅之前先算一遍它会有多吵。
 *
 * 这一步的价值不在于拦下几个词，在于**让用户在订阅那一刻就知道后果**。
 * 事后才发现太吵的人不会回来精简关键词，他会把整个通知关掉。
 */
export function checkNoise(hits7d: number): NoiseCheck {
  const perDay = Math.round((hits7d / 7) * 10) / 10;

  if (hits7d > NOISY_THRESHOLD_7D) {
    return {
      verdict: "noisy",
      hits7d,
      perDay,
      message:
        `过去七天命中 ${hits7d} 次（约每天 ${perDay} 次）—— 这个词太泛了。` +
        `每天最多提醒 ${MAX_HITS_PER_DAY} 次，所以你收到的会是这几十条里随机的几条，` +
        `换个更具体的词更有用`,
    };
  }
  if (hits7d > NOISY_THRESHOLD_7D / 2) {
    return {
      verdict: "busy",
      hits7d,
      perDay,
      message: `过去七天命中 ${hits7d} 次（约每天 ${perDay} 次），会比较频繁 —— 每天最多提醒 ${MAX_HITS_PER_DAY} 次`,
    };
  }
  if (hits7d === 0) {
    return {
      verdict: "ok",
      hits7d,
      perDay,
      message: "过去七天一次都没命中 —— 可以订阅，但也可能就是没人聊这个",
    };
  }
  return {
    verdict: "ok",
    hits7d,
    perDay,
    message: `过去七天命中 ${hits7d} 次，频率合适`,
  };
}

/**
 * 今天还该不该为这个词提醒。
 *
 * 每天封顶而不是永久静音：一个词今天突然被讨论了三十次，
 * 提醒五次之后闭嘴就够了 —— 用户已经知道有人在聊了。
 * 但明天要重新开始，不然一次热闹会让这个订阅永远失效。
 */
export function shouldNotify(input: {
  hitsToday: number;
  lastNotifiedAt: number | null;
  now: number;
  /** 同一个词两次提醒之间的最小间隔 */
  minGapMs?: number;
}): { notify: boolean; reason: string } {
  if (input.hitsToday >= MAX_HITS_PER_DAY) {
    return { notify: false, reason: `今天已经提醒 ${MAX_HITS_PER_DAY} 次，明天再说` };
  }

  const gap = input.minGapMs ?? 10 * 60_000;
  if (input.lastNotifiedAt !== null && input.now - input.lastNotifiedAt < gap) {
    // 一串连续讨论不该变成一串连续通知
    return { notify: false, reason: "刚提醒过，等一会儿" };
  }

  return { notify: true, reason: "可以提醒" };
}

/**
 * 今天是不是新的一天（用于重置日计数）。
 *
 * **走 dateKey 而不是本地 Date** —— 这个站的「一天」是东八区的一天，
 * 签到连胜、日统计全都按那个算。这里用服务器本地时区的话，
 * 部署在别的时区上就会和签到差一天，而差的那一天没有任何地方看得出来。
 */
export function isNewDay(lastAt: number | null, now: number): boolean {
  if (lastAt === null) return true;
  return dateKey(lastAt) !== dateKey(now);
}
