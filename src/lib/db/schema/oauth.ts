import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 站点作为 OAuth 提供方。设计见 `docs/OAUTH-PROVIDER.md`。
 *
 * ═════════════════════════════════════════
 * 令牌不在这里 —— 它复用 `api_tokens`
 * ═════════════════════════════════════════
 *
 * 授权走完之后发出来的是一把和用户自己建的 `al_` 令牌**一模一样**的东西，
 * 只是多了 `app_id` 和 `expires_at` 两列。
 *
 * 不另起一套的理由：站里已经有一条完整的路 —— `authenticate()` 验 scope、
 * `sendAllowance()` 按人限流、`recordSend()` 留痕、「我的 → 开放 API」
 * 能撤销和看日志。另起一套要把这些每一条都重写一遍，
 * 而**重写出来的那份迟早少判一样东西**。
 */

/**
 * 应用。**只有管理员能建**，不开放自助注册。
 *
 * ─────────────────────────────────────────
 * 这不是嫌麻烦，是防钓鱼
 * ─────────────────────────────────────────
 *
 * 一个开放自助注册的 OAuth 提供方，等于给钓鱼者发了一个官方授权页：
 * 在一千六百人的群里发「授权登录领积分」，那个授权页长得和真的一样 ——
 * 因为**它就是真的**。OAuth 的钓鱼不靠伪造页面，靠伪造应用。
 *
 * 管理员建，意味着这份名单是被人看过的。代价是加应用要找站长，
 * 这是对的代价。
 */
export const oauthApps = sqliteTable(
  "oauth_apps",
  {
    id: ulidPk(),
    /** 对外的应用标识，`alc_` 开头 */
    clientId: text("client_id").notNull(),
    /**
     * 机密客户端的密钥**哈希**。公开客户端（纯前端、移动端）为 null ——
     * 那种客户端藏不住密钥，给它一个只是制造「它是安全的」的错觉。
     */
    clientSecretHash: text("client_secret_hash"),

    name: text("name").notNull(),
    description: text("description"),
    /** 应用主页，同意页上显示 —— 让人有地方查这是谁 */
    homepage: text("homepage"),

    /**
     * 回调地址。**精确匹配，不许通配、不许前缀匹配、不许子路径。**
     *
     * 这个仓库在同类问题上交过学费（见 `lib/github/link-refs.ts`：
     * host 只做全等比较、拒绝带 userinfo 和端口的 URL）。照那套判。
     */
    redirectUri: text("redirect_uri").notNull(),

    /** 建它的管理员 —— 同意页上要显示「谁批的」 */
    ownerAdminId: text("owner_admin_id").notNull(),

    /**
     * 允许申请 `groups:send` 吗。**默认 false。**
     *
     * 理由不是「危险」，是**它会让审计说谎**：逐群发送授权是站长发给
     * 一个具体的人的，理由那栏写着「他在维护打卡机器人」。
     * 一旦第三方应用能拿到，代发日志里仍然写着那个人的名字，
     * 而真正按下发送的是一段谁也没 review 过的代码。
     */
    allowSend: integer("allow_send", { mode: "boolean" }).notNull().default(false),

    createdAt: now("created_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [uniqueIndex("oauth_apps_client_id_idx").on(t.clientId), index("oauth_apps_owner_idx").on(t.ownerAdminId)],
);

/**
 * 「某个人授权了某个应用」这件长期关系。
 *
 * 撤销它 = 连同它签出的所有令牌一起失效。放在这里而不是只靠令牌，
 * 是因为用户心里想的是「我不再让这个应用用我的账号」，
 * 不是「我要撤销那三把令牌」。
 */
export const oauthGrants = sqliteTable(
  "oauth_grants",
  {
    id: ulidPk(),
    appId: text("app_id").notNull(),
    userId: text("user_id").notNull(),
    /** 他同意过的 scope，JSON 数组 */
    scopes: text("scopes", { mode: "json" }).notNull().$type<string[]>(),
    createdAt: now("created_at"),
    /** 最近一次重新同意（scope 变了要重新问） */
    updatedAt: now("updated_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [
    uniqueIndex("oauth_grants_app_user_idx").on(t.appId, t.userId),
    index("oauth_grants_user_idx").on(t.userId),
  ],
);

/**
 * 一次性的授权码。
 *
 * ─────────────────────────────────────────
 * 用过就**删**，不是标记已用
 * ─────────────────────────────────────────
 *
 * 标记已用的话，「这一行还在」和「它能不能再用一次」变成两件事，
 * 而判断第二件要读一个字段 —— 那个判断迟早有人忘了写。
 * 删掉之后，「找不到」就是唯一的答案。
 *
 * 60 秒过期：授权码从浏览器跳回应用后端，正常只需要几百毫秒。
 */
export const oauthCodes = sqliteTable(
  "oauth_codes",
  {
    /** 码本身的哈希 —— 和令牌同一条口径，库里不留明文 */
    codeHash: text("code_hash").primaryKey(),
    appId: text("app_id").notNull(),
    userId: text("user_id").notNull(),
    scopes: text("scopes", { mode: "json" }).notNull().$type<string[]>(),
    /** PKCE：`S256(code_verifier)`。**必填** —— 不接受没有 PKCE 的请求 */
    codeChallenge: text("code_challenge").notNull(),
    /** 换令牌时要和请求里的 redirect_uri 逐字相等 */
    redirectUri: text("redirect_uri").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: now("created_at"),
  },
  (t) => [index("oauth_codes_expires_idx").on(t.expiresAt)],
);

/**
 * 刷新令牌。**一次性轮换。**
 *
 * 检测到复用（同一个 refresh 用了两次）就把**整条授权**撤销 ——
 * 复用只有两种可能：应用写错了，或者令牌被偷了。两种都该停下来，
 * 而在停下来这件事上，宁可错杀一个写错的应用。
 */
export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    grantId: text("grant_id").notNull(),
    /** 它签出来的那把访问令牌，轮换时一并作废 */
    accessTokenId: text("access_token_id"),
    expiresAt: integer("expires_at").notNull(),
    /** 用过的时间。非 null 而又被拿来用 = 复用，触发整条授权撤销 */
    usedAt: integer("used_at"),
    createdAt: now("created_at"),
  },
  (t) => [index("oauth_refresh_grant_idx").on(t.grantId)],
);
