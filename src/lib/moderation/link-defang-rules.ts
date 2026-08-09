/**
 * 新人外链降权。
 *
 * ─────────────────────────────────────────
 * 为什么不再直接拦下来
 * ─────────────────────────────────────────
 *
 * 拦截只教会人「这里不让说话」。一个新人被拦一次，多半就不发第二次了 ——
 * 而我们要挡的是广告号，不是第一天来的人。
 *
 * 所以改成**放行 + 降权 + 说明**：内容照常发出来，但链接里的点和 `://`
 * 被包起来（`example[.]com`、`https[://]example[.]com`），点不动、也不会
 * 被客户端自动识别成链接；同时明确告诉他「满 N 天之后再发就不会这样了」。
 * 那句话是这条规则唯一有教育意义的部分。
 *
 * 用 `[.]` 而不是 `·`：`[.]` 是安全圈通用的 defang 写法，一眼就看得出
 * 「这是被故意拆开的」，而 `·` 更像是打错的标点，人会以为是站点的 bug。
 *
 * ─────────────────────────────────────────
 * 边界划在哪
 * ─────────────────────────────────────────
 *
 * 判据是「**在渲染结果里点得动、或者复制粘贴就能直达**」：
 *
 *   · 带 scheme 的（`https://…`）—— 一律处理，不看后缀。这种在任何客户端
 *     里都是可点的，后缀再冷门也一样。
 *   · 裸域名（`example.com`）—— 只认常见后缀白名单。复制到地址栏就能直达，
 *     所以要处理；但不能靠「有个点 + 两个字母」来认，那样
 *     `Object.keys`、`a.png`、`v1.2.3`、`user.id` 全都要遭殃，
 *     而误伤正常句子的代价比漏掉一个冷门后缀的裸域名大得多。
 *   · `example dot com`、`example . com` —— **不处理**。它本来就点不动，
 *     要人手动改写才能用，等于发的人自己已经降过权了；再去追这种写法
 *     只会开始误伤正常句子（「1 . 5 米」），而挡不住任何真的想发广告的人。
 *   · 站内链接 —— 不处理。指向本站的不是「外链」。
 *   · 代码块里的 —— 不处理。markdown 不会把代码里的 URL 变成链接，
 *     所以那里没有可点性可降，而把别人的代码改坏是实打实的伤害。
 *
 * 这一层是**纯函数**，不读库、不读时钟。「满没满 N 天」由调用方算好传进来。
 */

/** 站内域名。指向本站的链接不是外链 */
export const DEFAULT_SITE_HOSTS = ["agenticlab.sh", "localhost"];

/**
 * 裸域名认哪些后缀。
 *
 * 白名单而不是「点后面两个字母就算」—— 后者在一个技术社区里等于
 * 把所有属性访问和文件名都拆了。反过来，这个表里**故意不放**那些
 * 在代码里高频出现的词，即使它们确实是 TLD：
 *
 *   `.id` `.name` `.is` `.host` `.email` `.group` `.click` `.store` `.run`
 *   `.page` `.app` `.map` `.test`  → `user.id`、`Object.is`、`regex.test`
 *   `.md` `.sh` `.rs` `.cc` `.so` `.zip` `.mov`  → 全是文件后缀
 *
 * 漏掉的那些用冷门后缀的裸域名本来就点不动，代价只是广告文字还在；
 * 而误伤一次 `user.id` 是把别人写的东西改坏了。
 */
export const COMMON_TLDS: ReadonlySet<string> = new Set([
  // 通用
  "com", "net", "org", "edu", "gov", "int",
  // 新通用顶级域里广告最常用的那批
  "io", "co", "me", "tv", "top", "xyz", "icu", "vip", "shop", "site", "online",
  "club", "fun", "work", "link", "buzz", "space", "tech", "website", "info",
  "biz", "pro", "mobi", "asia", "wang", "ren", "xin", "ltd", "art", "life",
  "world", "today", "news", "blog", "cloud", "chat", "cool", "plus", "red",
  "gold", "win", "bet", "cash", "fund", "loan", "credit", "ooo", "pw",
  "tk", "ml", "ga", "cf", "gq", "su", "ws", "dev", "ai",
  // 国家和地区
  "cn", "jp", "kr", "hk", "tw", "uk", "us", "de", "fr", "it", "es", "ru",
  "br", "au", "ca", "nz", "sg", "my", "th", "vn", "ph", "tr", "nl", "se",
  "fi", "dk", "ch", "be", "cz", "gr", "pt", "il", "ae", "sa", "za", "mx",
  "ar", "cl", "pe", "ua", "by", "kz", "in",
]);

export interface DefangOptions {
  /** 站内域名，命中的不处理 */
  siteHosts?: readonly string[];
}

/**
 * 带 scheme 的链接。host 部分单独抓出来 —— 只拆 host，路径不动：
 * host 一拆，整条就已经不可点了，再去动路径只会让人看不懂原本是什么。
 */
const SCHEME_URL = /\b(https?):\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)/gi;

/**
 * 裸域名。
 *
 * 前面那一位不能是 `\w` / `@` / `.` / `-`：
 *   · `\w` 和 `-` 挡住 `v1.2.3` 这类中间片段
 *   · `@` 挡住邮箱（邮箱不是可点的链接，是另一码事）
 *   · `.` 挡住 `1.2.3` 里的后半截
 * 后面那一位同理，避免把 `foo.co.uk` 拆成两半来判。
 */
const BARE_DOMAIN = /(^|[^\w@./-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}))(?![\w.-])/gi;

export function isSiteHost(host: string, siteHosts: readonly string[] = DEFAULT_SITE_HOSTS): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  return siteHosts.some((site) => h === site || h.endsWith(`.${site}`));
}

/** 把 host 里的点包起来 */
function wrapDots(host: string): string {
  return host.replace(/\./g, "[.]");
}

export interface DefangResult {
  text: string;
  /** 处理掉几个 —— 0 表示这段里没有可点的外链 */
  count: number;
}

/**
 * 纯文本 / markdown 原文上的降权。
 *
 * 写入时用它来判「这段里有没有外链」（`count > 0`），
 * 渲染时用它来处理正文里的文字节点。
 */
export function defangText(text: string, options: DefangOptions = {}): DefangResult {
  const siteHosts = options.siteHosts ?? DEFAULT_SITE_HOSTS;
  let count = 0;

  // ① 带 scheme 的一律处理，不看后缀 —— 这种到哪儿都是可点的
  let out = text.replace(SCHEME_URL, (match, scheme: string, host: string) => {
    if (isSiteHost(host, siteHosts)) return match;
    count += 1;
    return `${scheme}[://]${wrapDots(host)}`;
  });

  // ② 裸域名只认白名单后缀，理由见 COMMON_TLDS 上面那段
  out = out.replace(BARE_DOMAIN, (match, lead: string, domain: string, tld: string) => {
    if (!COMMON_TLDS.has(tld.toLowerCase())) return match;
    if (isSiteHost(domain, siteHosts)) return match;
    count += 1;
    return `${lead}${wrapDots(domain)}`;
  });

  return { text: out, count };
}

/** 这段里有没有可点的外链。写入时用来决定要不要附那句说明 */
export function countExternalLinks(text: string, options: DefangOptions = {}): number {
  return defangText(text, options).count;
}

/** `<a href>` 指向站外吗。相对路径、锚点、mailto 都不算 */
export function isExternalHref(href: string, siteHosts: readonly string[] = DEFAULT_SITE_HOSTS): boolean {
  const match = /^(https?):\/\/([^/?#]+)/i.exec(href.trim());
  if (!match) return false;
  return !isSiteHost(match[2], siteHosts);
}

/** 代码块。里面的东西一概不动 —— 那里没有可点性可降，改坏了倒是真的 */
const CODE_REGION = /<pre\b[\s\S]*?<\/pre>|<code\b[\s\S]*?<\/code>/gi;
const ANCHOR = /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
const TAG = /(<[^>]*>)/;

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

/**
 * 渲染结果（已消毒的 HTML）上的降权。
 *
 * 分两步：
 *   ① `<a>` 整个换成文字 —— 剩一个 a 标签就还是可点的，只把里面的点包起来
 *      等于没做。锚文字和网址不一样时（`[点这里](http://spam.com)`）两个都留下，
 *      否则「点这里」还在、网址没了，读的人只会莫名其妙。
 *   ② 剩下的文字节点走 defangText。标签内部（属性）不碰，
 *      所以不会把 `href="/u/xxx"` 这种站内地址改坏。
 *
 * 只删标签、只插已经转义过的文字，不新增任何标签 —— 出去的东西
 * 仍然在消毒时定下的那个允许清单之内。
 */
export function defangHtml(html: string, options: DefangOptions = {}): { html: string; count: number } {
  const siteHosts = options.siteHosts ?? DEFAULT_SITE_HOSTS;
  let count = 0;

  const process = (chunk: string): string => {
    // ① 外链的 <a> 整个换掉
    const withoutAnchors = chunk.replace(ANCHOR, (match, href: string, inner: string) => {
      if (!isExternalHref(href, siteHosts)) return match;
      count += 1;
      const shown = defangText(href, { siteHosts }).text;
      const label = stripTags(inner);
      // 锚文字就是网址本身时不要重复一遍
      if (!label || label === href || `${label}/` === href || label === href.replace(/\/$/, "")) {
        return shown;
      }
      return `${label}（${shown}）`;
    });

    // ② 文字节点。标签原样放回去
    return withoutAnchors
      .split(TAG)
      .map((piece) => {
        if (!piece || piece.startsWith("<")) return piece;
        const result = defangText(piece, { siteHosts });
        count += result.count;
        return result.text;
      })
      .join("");
  };

  // 代码区整段跳过，其余按上面两步处理
  let out = "";
  let last = 0;
  CODE_REGION.lastIndex = 0;
  for (let m = CODE_REGION.exec(html); m; m = CODE_REGION.exec(html)) {
    out += process(html.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  out += process(html.slice(last));

  return { html: out, count };
}

/**
 * 注册满没满 N 天。
 *
 * 时钟由调用方读进来 —— 渲染期读 `Date.now()` 会被 React 编译器拦，
 * 拦得对：同一屏上早晚不同的内容会用上不同的「现在」。
 *
 * 没有绑定时间的按新人算：这个字段只在从来没绑过的账号上是空的，
 * 而那种账号恰恰是最该防的。
 */
export function isNewbie(firstBoundAt: number | null | undefined, days: number, now: number): boolean {
  if (days <= 0) return false;
  if (!firstBoundAt) return true;
  return now - firstBoundAt <= days * 86_400_000;
}

/**
 * 给新人的那句话。
 *
 * 写法上守三条，缺一条这句话就白写了：
 *   ① 先说**东西已经发出去了** —— 人最怕的是白写一场
 *   ② 说清楚**为什么**，而且点明不是针对他（「新号都这样」）
 *   ③ 给一个**确定的时间点**，并且说明老帖子会自己好起来 ——
 *      降权是渲染时算的，满 N 天之后这篇里的链接确实会自动恢复
 */
export function newbieLinkNotice(days: number, what: "帖子" | "回复" = "帖子"): string {
  return (
    `${what}已经发出来了。只是你注册还不满 ${days} 天，里面的链接暂时会显示成 ` +
    `example[.]com 这样点不动的形式 —— 新号都这样，挡的是广告不是你。` +
    `满 ${days} 天之后再发就不会了，这一篇里的链接到时候也会自己恢复。`
  );
}

/** 作者回头看自己被降权的帖子时，在正文旁边解释一句 */
export function defangedAuthorHint(days: number): string {
  return `你注册还不满 ${days} 天，这里的链接暂时被拆成了点不动的形式。满 ${days} 天之后会自己恢复，不用重发。`;
}
