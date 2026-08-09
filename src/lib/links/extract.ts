/**
 * 从聊天消息里抽链接。纯函数。
 *
 * ─────────────────────────────────────────
 * 中文和 URL 之间常常没有空格
 * ─────────────────────────────────────────
 *
 * 真实数据里长这样：
 *
 *   https://cloud.siliconflow.cn/i/Cn0CsuOt现在硅基流动注册认证给16块钱
 *   https://typhoon.nmc.cn/web.html 可以使用此网站查询实时的台风情报
 *
 * 第一条如果用常见的 `https?://\S+` 去匹配，抓到的是
 * 「…Cn0CsuOt现在硅基流动注册认证给16块钱」——
 * 一个打不开的地址，而且**看起来完全正常**：它有协议、有域名、有路径，
 * 列表里显示出来也不刺眼，只有点进去才发现是 404。
 *
 * 所以 URL 必须在**第一个 CJK 字符**处停下，
 * 也要处理句尾标点：`见 https://a.com/b。` 里的句号不属于地址。
 */

/**
 * URL 的合法尾字符集合。
 *
 * 停在 CJK、空白、全角标点之前；ASCII 的成对符号和句读也不能吃进来。
 * 用「允许什么」而不是「排除什么」——
 * 排除法每漏一个字符就多一条脏数据，而允许法漏了只是少抓一点。
 */
const URL_BODY = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;

/** 结尾常见的、几乎一定不属于地址的字符 */
const TRAILING_JUNK = /[.,;:!?'")\]}>、。，；：！？）】》」』]+$/;

/**
 * 成对符号要配平。
 *
 * 维基百科那种带括号的地址（`/wiki/Foo_(bar)`）不能被尾部清理砍掉，
 * 而「（见 https://a.com/b）」里的右括号必须砍掉。
 * 判据是括号在地址里配不配得平。
 */
function trimTrailing(url: string): string {
  let result = url;
  for (;;) {
    const next = result.replace(TRAILING_JUNK, "");
    if (next === result) break;

    // 砍掉之后如果左括号反而多了，说明这个右括号是地址的一部分
    const balanced = (s: string) =>
      (s.match(/\(/g)?.length ?? 0) <= (s.match(/\)/g)?.length ?? 0);
    if (!balanced(next) && balanced(result)) break;

    result = next;
  }
  return result;
}

export function extractUrls(text: string): string[] {
  if (!text) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  const starts = /https?:\/\//gi;

  for (const match of text.matchAll(starts)) {
    const from = match.index ?? 0;
    let end = from + match[0].length;
    while (end < text.length && URL_BODY.test(text[end])) end++;

    const raw = trimTrailing(text.slice(from, end));
    // 光有协议没有主机的不算
    if (!/^https?:\/\/[^/]+\./i.test(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }

  return out;
}

// ── 归一化 ──────────────────────────────────────────────────

/**
 * 追踪参数。
 *
 * 同一篇文章从不同人手里转出来，query 上挂的东西不一样，
 * 不去掉的话资源库里会有五条一模一样的链接 ——
 * 而「同一个东西出现五次」正是资源库最没用的样子。
 */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^spm$/i,
  /^scm$/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^msclkid$/i,
  /^ref$/i,
  /^ref_src$/i,
  /^from$/i,
  /^share_/i,
  /^share$/i,
  /^wxshare/i,
  /^_hsenc$/i,
  /^mc_[ce]id$/i,
  /^igshid$/i,
  /^si$/i,
];

function isTracking(key: string): boolean {
  return TRACKING_PARAMS.some((re) => re.test(key));
}

export interface NormalizedUrl {
  /** 去重用的键 */
  key: string;
  /** 清理过、可以直接点的地址 */
  url: string;
  domain: string;
}

/**
 * 归一化。
 *
 * 去重键和展示地址**分开**：
 * 键上抹掉 www.、末尾斜杠、协议差异；展示地址保留 https 与原本的主机名，
 * 因为点开的时候这些是有意义的。
 *
 * 返回 null 表示这个地址不该进资源库（内网、本站、非 http）。
 */
export function normalizeUrl(raw: string, selfHosts: string[] = []): NormalizedUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const host = parsed.hostname.toLowerCase();
  if (!host.includes(".")) return null;
  /*
   * 内网地址不收。
   * 它们对别人毫无用处，而且把内网地址列在一个公开页面上
   * 等于免费给人做了一次内网测绘。
   */
  if (isPrivateHost(host)) return null;
  if (selfHosts.some((self) => host === self || host.endsWith(`.${self}`))) return null;

  // query 里去掉追踪参数，其余保留并排序 —— 顺序不同不该算两个链接
  const params = [...parsed.searchParams.entries()]
    .filter(([key]) => !isTracking(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const search = params.length > 0
    ? "?" + params.map(([k, v]) => `${k}=${v}`).join("&")
    : "";

  // 展示地址：保留原主机与协议，只去掉追踪参数和 fragment
  const url = `${parsed.protocol}//${parsed.host}${parsed.pathname}${search}`.replace(
    /\/$/,
    parsed.pathname === "/" ? "/" : "",
  );

  // 去重键：再抹掉 www.、协议、末尾斜杠
  const keyHost = host.replace(/^www\./, "");
  const keyPath = parsed.pathname.replace(/\/+$/, "");
  const key = `${keyHost}${keyPath}${search}`.toLowerCase();

  return { key, url, domain: keyHost };
}

/** 内网 / 本机 —— 收进公开页面等于免费做一次内网测绘 */
export function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (/^127\./.test(host) || host === "0.0.0.0" || host === "::1") return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  return false;
}

// ── 从消息里取标题 ──────────────────────────────────────────

/**
 * 拿消息正文当链接的说明。
 *
 * 不去抓网页标题：那要发出站请求，慢、会失败、还要防 SSRF，
 * 而**发链接的人往往已经写了一句更有用的话**——
 * 「可以使用此网站查询实时的台风情报」比 `<title>台风网</title>` 好得多。
 *
 * 抓不到就留空，页面上显示域名 + 路径。留空比编一个标题好。
 */
export function contextFor(content: string, url: string, maxLength = 80): string | null {
  const index = content.indexOf(url);
  if (index === -1) return clean(content, maxLength);

  const before = content.slice(0, index);
  const after = content.slice(index + url.length);

  // 后面的话通常是在解释这个链接；前面的话通常是在铺垫
  const candidate = clean(after, maxLength) || clean(before, maxLength);
  return candidate;
}

function clean(text: string, maxLength: number): string | null {
  const stripped = text
    // 同一条消息里的其它链接不要混进说明
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length < 2) return null;
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength)}…` : stripped;
}

/**
 * 域名的可读名。
 *
 * 只做最常见的那几个 —— 一张一百行的映射表维护不动，
 * 而且认不出来的时候显示域名本身完全够用。
 */
const DOMAIN_LABELS: Record<string, string> = {
  "github.com": "GitHub",
  "arxiv.org": "arXiv",
  "huggingface.co": "Hugging Face",
  "zhihu.com": "知乎",
  "bilibili.com": "哔哩哔哩",
  "mp.weixin.qq.com": "微信公众号",
  "x.com": "X",
  "twitter.com": "X",
  "youtube.com": "YouTube",
  "juejin.cn": "掘金",
  "medium.com": "Medium",
  "openai.com": "OpenAI",
  "anthropic.com": "Anthropic",
};

export function domainLabel(domain: string): string {
  return DOMAIN_LABELS[domain] ?? domain;
}

/**
 * GitHub 这类地址可以直接读出「什么东西」。
 *
 * 一屏全是 `github.com` 的资源库没法看 —— 真正区分它们的是仓库名。
 */
/** 这些末段等于没说 —— 显示站名比显示「index」有用 */
const GENERIC_SEGMENTS = new Set([
  "index",
  "web",
  "home",
  "main",
  "default",
  "page",
  "detail",
  "view",
  "zh",
  "cn",
  "en",
  "zh-cn",
]);

export function displayTitle(url: string, domain: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);

    if (domain === "github.com" && segments.length >= 2) {
      return `${segments[0]}/${segments[1]}`;
    }
    if (domain === "arxiv.org" && segments.length >= 1) {
      return `arXiv ${segments[segments.length - 1]}`;
    }
    if (segments.length === 0) return domainLabel(domain);

    /*
     * 末段先脱掉扩展名。
     * 真实数据里有 `typhoon.nmc.cn/web.html`，直接拿末段当标题
     * 会在列表里显示成「web.html」—— 一个文件名，看不出是什么。
     */
    const last = decodeURIComponent(segments[segments.length - 1]).replace(
      /\.(html?|php|aspx?|jsp|do|action)$/i,
      "",
    );

    // 通用得没有信息量的末段一律退回站名
    if (last.length < 2 || GENERIC_SEGMENTS.has(last.toLowerCase())) {
      return domainLabel(domain);
    }
    return last;
  } catch {
    return domainLabel(domain);
  }
}
