import { createHash, timingSafeEqual } from "node:crypto";

import { SCOPE_KEYS, type ScopeKey } from "@/lib/api-tokens/rules";

/**
 * OAuth 提供方的纯规则。不碰库、不碰 React。
 *
 * 整体设计见 `docs/OAUTH-PROVIDER.md`。这个文件是那份设计里
 * **每一条能写成函数的判断**，放在一处是为了它们能被单独测 ——
 * 这些判断错一条的后果是「别人的账号被别人用」，
 * 而那种错不会在任何日志里显形。
 */

/** 应用标识的前缀，和令牌的 `al_` 区分开 —— 看一眼就知道是哪一类东西 */
export const CLIENT_ID_PREFIX = "alc_";

/** 授权码活多久。浏览器跳回应用后端正常只要几百毫秒，60 秒已经很宽 */
export const CODE_TTL_MS = 60_000;

/** 访问令牌活多久。和会话同一个数量级 —— 见 `auth.session.ttl_days` */
export const ACCESS_TTL_MS = 30 * 86_400_000;

/** 刷新令牌活多久。比访问令牌长，但不是永久 */
export const REFRESH_TTL_MS = 180 * 86_400_000;

/**
 * OAuth **不能**申请的 scope。
 *
 * ═════════════════════════════════════════
 * `groups:send` 不进 OAuth
 * ═════════════════════════════════════════
 *
 * 理由不是「危险」，是**它会让审计说谎**。
 *
 * 逐群发送授权是站长发给**一个具体的人**的，理由那一栏写着
 * 「他在维护打卡机器人」。一旦第三方应用能拿到这个 scope，
 * 代发日志里仍然写着那个人的名字，而真正按下发送的是一段
 * 谁也没 review 过的代码 —— 那条记录从此不再回答它本来要回答的问题
 * 「出事那天，是谁让机器人说的这句话」。
 *
 * 应用被管理员单独勾了 `allowSend` 才解锁，而且解锁之后仍然要求
 * 用户**本人已经持有那个群的逐群授权**（OAuth 不能凭空产生授权），
 * 并且署名里要同时写出应用名。三个条件缺一不可。
 */
export const OAUTH_BLOCKED_SCOPES: readonly ScopeKey[] = ["groups:send"];

/** 这个应用能申请哪些 scope */
export function allowedScopesFor(app: { allowSend: boolean }): ScopeKey[] {
  return SCOPE_KEYS.filter((s) => app.allowSend || !OAUTH_BLOCKED_SCOPES.includes(s));
}

/**
 * 解析 `scope` 参数。
 *
 * 空格分隔（RFC 6749）。认不出来的一律**拒绝整个请求**，
 * 而不是悄悄丢掉那一项 —— 悄悄丢掉的话，应用以为自己拿到了
 * 某个权限，直到某天调用返回 403 才发现，而那时候它已经上线了。
 */
export function parseScopes(
  raw: string | null,
  app: { allowSend: boolean },
): { ok: true; scopes: ScopeKey[] } | { ok: false; error: string } {
  const wanted = (raw ?? "").split(/[\s+]+/).filter(Boolean);
  if (wanted.length === 0) return { ok: false, error: "至少要申请一项权限（scope）" };

  const allowed = allowedScopesFor(app);
  const unknown = wanted.filter((s) => !SCOPE_KEYS.includes(s as ScopeKey));
  if (unknown.length > 0) {
    return { ok: false, error: `不认识这些权限：${unknown.join("、")}` };
  }
  const blocked = wanted.filter((s) => !allowed.includes(s as ScopeKey));
  if (blocked.length > 0) {
    return {
      ok: false,
      error: `这个应用不能申请：${blocked.join("、")}`,
    };
  }
  // 去重并按登记表的顺序排 —— 同意页上每次的顺序要一样
  const set = new Set(wanted as ScopeKey[]);
  return { ok: true, scopes: SCOPE_KEYS.filter((s) => set.has(s)) };
}

/**
 * 回调地址是不是这个应用注册的那一个。
 *
 * ═════════════════════════════════════════
 * **精确匹配**，一个字符都不能差
 * ═════════════════════════════════════════
 *
 * 不许通配、不许前缀匹配、不许子路径。理由是这个仓库已经交过的学费
 * （`lib/github/link-refs.ts`）：只要留一点「差不多就行」的余地，
 * 攻击者就能构造一个既满足规则、又指向他自己的地址。
 *
 * 用字符串全等而不是解析成 URL 再逐段比：解析会引入
 * 「`https://x.test/cb` 和 `https://x.test/cb/` 算不算同一个」
 * 这类问题，而每一个这样的问题都是一次「差不多就行」。
 * 注册什么就用什么。
 */
export function redirectMatches(registered: string, given: string | null): boolean {
  return typeof given === "string" && given.length > 0 && given === registered;
}

/**
 * 注册的回调地址本身合不合法。建应用时校验一次。
 *
 * 这一层挡的是**管理员自己填错**，而不是攻击者 —— 但填错的后果
 * 一样：一个指向 `http://` 的回调，会让授权码在明文里走一趟。
 */
export function validateRedirectUri(raw: string): { ok: boolean; error?: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "不是一个合法的地址" };
  }
  /*
   * 只认 https，除了 localhost。
   *
   * 本地开发要能用，而 localhost 上的明文流量不出这台机器。
   * 别的 http 地址一律拒 —— 授权码在明文里走一趟就等于泄露。
   */
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    return { ok: false, error: "必须是 https（localhost 可以用 http）" };
  }
  // 带用户名密码的地址是经典的钓鱼形状：`https://好域名@坏域名/`
  if (url.username || url.password) {
    return { ok: false, error: "地址里不能带用户名或密码" };
  }
  // 片段在跳转时不会传给服务端，写了也没用，但它说明填的人搞错了
  if (url.hash) return { ok: false, error: "地址里不能带 # 片段" };
  return { ok: true };
}

/**
 * PKCE 校验：`S256(verifier)` 是不是等于当初存下的 challenge。
 *
 * ─────────────────────────────────────────
 * 只认 S256，不认 plain
 * ─────────────────────────────────────────
 *
 * `plain` 是规范里为了兼容老设备留的口子，它等于没有 PKCE ——
 * 能偷到授权码的人同样能偷到 verifier。留着它的唯一作用是
 * 让一个错误的实现看起来像通过了。
 */
export function verifyPkce(challenge: string, verifier: string | null): boolean {
  if (!verifier || verifier.length < 43 || verifier.length > 128) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  // 长度不同时 timingSafeEqual 会抛，所以先比长度
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 存进库的一律是哈希 —— 和令牌同一条口径，库里不留明文 */
export function hashSecret(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * 授权过的 scope 够不够这次要的。
 *
 * 不够就要**重新同意**，不能靠上次的同意悄悄扩权 ——
 * 这是同意页存在的全部意义：他同意的是他看见的那几项。
 */
export function coversScopes(granted: readonly string[], wanted: readonly string[]): boolean {
  const have = new Set(granted);
  return wanted.every((s) => have.has(s));
}

/**
 * 授权结束后跳回哪里。
 *
 * 拼参数用 `URLSearchParams` 而不是字符串拼接：注册的地址里可能
 * 本来就带 query（`https://x.test/cb?tenant=a`），手拼会拼出
 * 两个 `?`，而那种地址在有些客户端上会静默失败。
 */
export function callbackWith(
  redirectUri: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  return url.toString();
}
