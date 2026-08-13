import "server-only";

import { randomBytes } from "node:crypto";

import { and, eq, isNull, lt } from "drizzle-orm";

import { createToken, revokeToken } from "@/lib/api-tokens/store";
import type { ScopeKey } from "@/lib/api-tokens/rules";
import { db } from "@/lib/db";
import {
  apiTokens,
  oauthApps,
  oauthCodes,
  oauthGrants,
  oauthRefreshTokens,
} from "@/lib/db/schema";

import {
  ACCESS_TTL_MS,
  CLIENT_ID_PREFIX,
  CODE_TTL_MS,
  hashSecret,
  REFRESH_TTL_MS,
} from "./rules";

/**
 * OAuth 的库操作。规则在 `rules.ts`，这里只负责读写。
 */

export interface OAuthApp {
  id: string;
  clientId: string;
  name: string;
  description: string | null;
  homepage: string | null;
  redirectUri: string;
  ownerAdminId: string;
  allowSend: boolean;
  hasSecret: boolean;
}

function toApp(row: typeof oauthApps.$inferSelect): OAuthApp {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    description: row.description,
    homepage: row.homepage,
    redirectUri: row.redirectUri,
    ownerAdminId: row.ownerAdminId,
    allowSend: row.allowSend,
    // 只说有没有，**永远不回明文** —— 它只在创建那一刻出现过一次
    hasSecret: Boolean(row.clientSecretHash),
  };
}

/** 按 client_id 找一个**没被撤销**的应用 */
export function appByClientId(clientId: string): OAuthApp | null {
  const row = db
    .select()
    .from(oauthApps)
    .where(and(eq(oauthApps.clientId, clientId), isNull(oauthApps.revokedAt)))
    .get();
  return row ? toApp(row) : null;
}

export function listApps(): OAuthApp[] {
  return db
    .select()
    .from(oauthApps)
    .where(isNull(oauthApps.revokedAt))
    .all()
    .map(toApp);
}

export function createApp(input: {
  name: string;
  description?: string | null;
  homepage?: string | null;
  redirectUri: string;
  ownerAdminId: string;
  allowSend?: boolean;
  /** 机密客户端要密钥；公开客户端（纯前端）不要 —— 它藏不住 */
  wantSecret: boolean;
}): { app: OAuthApp; clientSecret?: string } {
  const clientId = `${CLIENT_ID_PREFIX}${randomBytes(12).toString("hex")}`;
  const secret = input.wantSecret ? randomBytes(32).toString("base64url") : undefined;

  db.insert(oauthApps)
    .values({
      clientId,
      clientSecretHash: secret ? hashSecret(secret) : null,
      name: input.name,
      description: input.description ?? null,
      homepage: input.homepage ?? null,
      redirectUri: input.redirectUri,
      ownerAdminId: input.ownerAdminId,
      allowSend: input.allowSend ?? false,
    })
    .run();

  return { app: appByClientId(clientId)!, clientSecret: secret };
}

/** 撤销应用。**它签出的令牌立刻跟着失效** —— 见 revokeAppTokens */
export function revokeApp(id: string, reason: string): boolean {
  const row = db.select().from(oauthApps).where(eq(oauthApps.id, id)).get();
  if (!row || row.revokedAt) return false;

  db.update(oauthApps).set({ revokedAt: Date.now() }).where(eq(oauthApps.id, id)).run();
  revokeAppTokens(id, reason);
  return true;
}

/**
 * 把这个应用签出的令牌全部撤掉。
 *
 * 光把应用标成 revoked 是不够的：`authenticate()` 认的是令牌，
 * 它不知道那把令牌背后的应用已经没了。不撤的话，一个「已撤销」的应用
 * 还能继续用它手上的令牌 —— 而后台显示它已经被停了。
 */
export function revokeAppTokens(appId: string, reason: string): number {
  const rows = db
    .select({ id: apiTokens.id, userId: apiTokens.userId })
    .from(apiTokens)
    .where(and(eq(apiTokens.appId, appId), isNull(apiTokens.revokedAt)))
    .all();
  for (const r of rows) revokeToken(r.id, r.userId, reason);
  return rows.length;
}

/* ── 授权关系 ────────────────────────────────────────── */

export function grantOf(appId: string, userId: string) {
  return (
    db
      .select()
      .from(oauthGrants)
      .where(
        and(
          eq(oauthGrants.appId, appId),
          eq(oauthGrants.userId, userId),
          isNull(oauthGrants.revokedAt),
        ),
      )
      .get() ?? null
  );
}

/** 记下（或更新）一次同意 */
export function upsertGrant(appId: string, userId: string, scopes: ScopeKey[]): string {
  const existing = grantOf(appId, userId);
  if (existing) {
    db.update(oauthGrants)
      .set({ scopes, updatedAt: Date.now() })
      .where(eq(oauthGrants.id, existing.id))
      .run();
    return existing.id;
  }
  db.insert(oauthGrants).values({ appId, userId, scopes }).run();
  return grantOf(appId, userId)!.id;
}

/**
 * 用户撤销一个应用。
 *
 * 三件事一起做：授权关系作废、它签出的令牌作废、刷新令牌作废。
 * 少做任何一件，那个应用都还能继续用 —— 而用户以为自己已经断开了。
 */
export function revokeGrant(appId: string, userId: string, reason: string): boolean {
  const grant = grantOf(appId, userId);
  if (!grant) return false;

  db.update(oauthGrants)
    .set({ revokedAt: Date.now() })
    .where(eq(oauthGrants.id, grant.id))
    .run();

  db.delete(oauthRefreshTokens).where(eq(oauthRefreshTokens.grantId, grant.id)).run();

  const tokens = db
    .select({ id: apiTokens.id, userId: apiTokens.userId })
    .from(apiTokens)
    .where(and(eq(apiTokens.appId, appId), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .all();
  for (const t of tokens) revokeToken(t.id, t.userId, reason);
  return true;
}

/* ── 授权码 ──────────────────────────────────────────── */

export function issueCode(input: {
  appId: string;
  userId: string;
  scopes: ScopeKey[];
  codeChallenge: string;
  redirectUri: string;
}): string {
  const code = randomBytes(32).toString("base64url");
  db.insert(oauthCodes)
    .values({
      codeHash: hashSecret(code),
      appId: input.appId,
      userId: input.userId,
      scopes: input.scopes,
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      expiresAt: Date.now() + CODE_TTL_MS,
    })
    .run();
  return code;
}

/**
 * 取出并**立刻删除**一个授权码。
 *
 * 删而不是标记已用：标记的话，「这一行还在」和「它还能不能用」
 * 变成两件事，而判断第二件要读一个字段 —— 那个判断迟早有人忘了写。
 * 删掉之后「找不到」就是唯一的答案。
 *
 * 过期的也在这里一并清掉，省一个定时任务。
 */
export function consumeCode(code: string) {
  const hash = hashSecret(code);
  const row = db.select().from(oauthCodes).where(eq(oauthCodes.codeHash, hash)).get();

  // 无论对不对都先删 —— 一个码只有一次机会
  if (row) db.delete(oauthCodes).where(eq(oauthCodes.codeHash, hash)).run();
  db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, Date.now())).run();

  if (!row) return null;
  if (row.expiresAt < Date.now()) return null;
  return row;
}

/* ── 发令牌 ──────────────────────────────────────────── */

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: ScopeKey[];
}

/**
 * 发一对令牌。
 *
 * 访问令牌走的是**和用户自己建的完全相同**的那条路（`createToken`），
 * 只是多带了 `appId` 和 `expiresAt` —— 于是验令牌、限流、留痕、
 * 在「我的 → 开放 API」里撤销，全部免费继承。
 */
export function issueTokens(input: {
  appId: string;
  appName: string;
  grantId: string;
  userId: string;
  scopes: ScopeKey[];
}): IssuedTokens {
  const created = createToken({
    userId: input.userId,
    // 名字里带上应用名 —— 用户在列表里要认得出这把是谁的
    name: input.appName,
    scopes: input.scopes,
    appId: input.appId,
    expiresAt: Date.now() + ACCESS_TTL_MS,
  });

  const refresh = randomBytes(32).toString("base64url");
  db.insert(oauthRefreshTokens)
    .values({
      tokenHash: hashSecret(refresh),
      grantId: input.grantId,
      accessTokenId: created.id,
      expiresAt: Date.now() + REFRESH_TTL_MS,
    })
    .run();

  return {
    accessToken: created.plaintext,
    refreshToken: refresh,
    expiresIn: Math.floor(ACCESS_TTL_MS / 1000),
    scopes: input.scopes,
  };
}

/**
 * 用刷新令牌换一对新的。**一次性轮换。**
 *
 * ═════════════════════════════════════════
 * 检测到复用就把整条授权撤销
 * ═════════════════════════════════════════
 *
 * 复用只有两种可能：应用写错了（同一个 refresh 发了两次），
 * 或者令牌被偷了（攻击者和真应用各用了一次）。
 *
 * 两种都该停下来，而且**在停下来这件事上宁可错杀写错的那个应用** ——
 * 前者的代价是开发者看见一次错误、去修；后者的代价是
 * 一个人的账号被别人长期使用而没有任何人知道。
 */
export function rotateRefresh(raw: string):
  | { ok: true; grantId: string; userId: string; appId: string; scopes: ScopeKey[] }
  | { ok: false; error: string; reused?: boolean } {
  const hash = hashSecret(raw);
  const row = db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.tokenHash, hash)).get();
  if (!row) return { ok: false, error: "refresh token 无效" };

  if (row.usedAt !== null) {
    /*
     * 复用。把这条授权整个撤掉 —— 连同它签出的所有令牌。
     * 不只是拒绝这一次请求：如果是被偷了，攻击者手上那把访问令牌
     * 还能再用一个月。
     */
    const grant = db.select().from(oauthGrants).where(eq(oauthGrants.id, row.grantId)).get();
    if (grant) revokeGrant(grant.appId, grant.userId, "refresh token 被重复使用 —— 可能已泄露");
    return { ok: false, error: "refresh token 已经用过了，这条授权已被撤销", reused: true };
  }

  if (row.expiresAt < Date.now()) return { ok: false, error: "refresh token 过期了" };

  const grant = db
    .select()
    .from(oauthGrants)
    .where(and(eq(oauthGrants.id, row.grantId), isNull(oauthGrants.revokedAt)))
    .get();
  if (!grant) return { ok: false, error: "这条授权已经被撤销了" };

  // 标记用过，并作废它签出的那把访问令牌
  db.update(oauthRefreshTokens)
    .set({ usedAt: Date.now() })
    .where(eq(oauthRefreshTokens.tokenHash, hash))
    .run();
  if (row.accessTokenId) revokeToken(row.accessTokenId, grant.userId, "刷新时轮换");

  return {
    ok: true,
    grantId: grant.id,
    userId: grant.userId,
    appId: grant.appId,
    scopes: (grant.scopes as ScopeKey[]) ?? [],
  };
}
