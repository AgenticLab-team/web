/**
 * GitHub OAuth 的纯规则。不碰数据库、不碰网络、不读环境变量。
 *
 * 放在这里而不是路由文件里，是因为 OAuth 的安全性全在这几条判断上，
 * 而路由文件测不了 —— 它要 cookies()、要 fetch、要一个真的会话。
 * 判断挪出来之后，「state 对不上就必须拒绝」是一条能跑的测试，
 * 不是一句写在 code review 里的话。
 */

/** state 存在这个 cookie 里。httpOnly，前端读不到也改不了 */
export const GITHUB_STATE_COOKIE = "al_gh_state";

/**
 * state 的有效期。10 分钟 —— 够一个人在 GitHub 上登录一次、
 * 点一次授权；久到以小时计的话，一个泄露的 state 就有了一整天的可用窗口。
 */
export const GITHUB_STATE_TTL_MS = 10 * 60_000;

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_API_BASE = "https://api.github.com";

/**
 * 申请的权限范围：**空字符串，一个 scope 都不要**。
 *
 * 空 scope 的 token 只能读「任何匿名访客也能读到的东西」——
 * 公开资料、公开仓库、公开活动。它**碰不到任何私有仓库**，
 * 也发不了任何东西。
 *
 * 这不是省事，是把「默认只看公开仓库」这条决定放到了
 * 我们够不到的地方：即使将来某个人写错了代码去请求
 * `/user/repos?visibility=private`，GitHub 也只会返回 401 ——
 * 而如果我们申请了 `repo`，那份保证就只剩下代码里的自觉。
 *
 * 分享的目的是让别人看见。一个分享不出去的私有项目，
 * 拿它的数据没有任何用处，只有风险。
 */
export const GITHUB_SCOPE = "";

/** 授权页面的地址。redirectUri 必须与 OAuth App 里登记的完全一致，否则 GitHub 直接拒绝 */
export function authorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    // 每次都重新问一遍，不要沉默地复用上次的授权 ——
    // 「我什么时候把这个站连上 GitHub 的」应该有一次明确的点击
    allow_signup: "false",
  });
  if (GITHUB_SCOPE) params.set("scope", GITHUB_SCOPE);
  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * state 校验。**这是防 CSRF 的全部**。
 *
 * 没有它的话，攻击者可以在自己的页面上放一个指向我们回调地址、
 * 带着**他自己的** GitHub code 的链接。受害者点开，我们拿他的会话
 * 去换攻击者的 token —— 结果是受害者的站内账号绑上了攻击者的 GitHub。
 * 之后攻击者的仓库会出现在受害者主页上，而受害者不知道发生了什么。
 *
 * 三件事一起做：
 *   · 两边都得非空 —— 空等于空会让「压根没带 state」变成通过
 *   · 长度得一样 —— 顺带把 undefined / 截断的情况挡掉
 *   · 逐字符比较且**不提前返回** —— 提前返回会从响应时间上
 *     泄露「前几位对了」，让 state 可以被逐位试出来
 */
export function stateMatches(cookieValue: string | undefined, queryValue: string | null): boolean {
  if (!cookieValue || !queryValue) return false;
  if (cookieValue.length !== queryValue.length) return false;
  if (cookieValue.length < 16) return false;

  let diff = 0;
  for (let i = 0; i < cookieValue.length; i++) {
    diff |= cookieValue.charCodeAt(i) ^ queryValue.charCodeAt(i);
  }
  return diff === 0;
}

export interface GithubConfigFacts {
  clientId?: string;
  clientSecret?: string;
  tokenKey?: string;
}

/**
 * 配置齐了吗。**三项缺一不可**。
 *
 * 半套配置比没配置更糟：它会让入口按钮照常出现、
 * 点下去走到一半才失败，而失败的地方是 GitHub 的错误页 ——
 * 用户会以为是自己的 GitHub 有问题。
 *
 * tokenKey（32 字节，hex）也算配置的一部分：没有它就没法加密 token，
 * 而「没法加密就明文存」是这类功能最常见的退让。
 * 在这里把它列成必需项，那个退让就不存在了。
 */
export function githubConfigured(facts: GithubConfigFacts): boolean {
  if (!facts.clientId || !facts.clientSecret) return false;
  return isValidTokenKey(facts.tokenKey);
}

/** 加密密钥必须是 32 字节（64 个十六进制字符）—— AES-256 只认这个长度 */
export function isValidTokenKey(raw: string | undefined): boolean {
  return typeof raw === "string" && /^[0-9a-fA-F]{64}$/.test(raw);
}

/** 回调地址。写死在这里而不是让人配，配错了的表现是「授权完跳去一个 404」 */
export function callbackUrl(siteUrl: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/api/auth/github/callback`;
}

/**
 * 授权结束后回到站内哪一页。
 *
 * 只允许**站内相对路径**。放开成任意 URL 的话，这个回调就成了一个
 * 开放重定向：`.../callback?...&return=https://钓鱼站` ——
 * 而它挂在我们的域名下，看起来完全可信。
 */
export function safeReturnPath(raw: string | null | undefined, fallback = "/me/security"): string {
  if (!raw) return fallback;
  // 必须以单个 / 开头。`//evil.com` 和 `/\evil.com` 都会被浏览器当成协议相对地址
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  if (raw.includes("://") || /[\r\n]/.test(raw)) return fallback;
  return raw;
}

export type LinkFailure =
  | "not_configured"
  | "not_logged_in"
  | "bad_state"
  | "denied"
  | "exchange_failed"
  | "already_linked_elsewhere"
  | "already_linked_here";

/** 给用户看的话。**不暴露是哪个账号占着** —— 那等于回答「某人绑没绑 GitHub」 */
export const LINK_FAILURE_MESSAGE: Record<LinkFailure, string> = {
  not_configured: "这个站还没有配置 GitHub 绑定",
  not_logged_in: "请先登录，再绑定 GitHub",
  bad_state: "这次授权已经失效了，请重新点一次绑定",
  denied: "你在 GitHub 上取消了授权，没有绑定任何东西",
  exchange_failed: "没能连上 GitHub，稍后再试一次",
  already_linked_elsewhere: "这个 GitHub 账号已经绑过本站的另一个账号了",
  already_linked_here: "你已经绑过 GitHub 了，要换一个请先解绑",
};
