import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { apiSends, apiTokens, groupSendGrants, users } from "@/lib/db/schema";

import {
  checkSendLimit,
  effectiveLimits,
  formatToken,
  looksLikeToken,
  normalizeScopes,
  type LimitVerdict,
  type ScopeKey,
} from "./rules";

/**
 * 令牌的存取与校验。
 *
 * 规则在 `rules.ts`（纯函数、离线测得密），这里只负责落库和查库。
 */

/** SHA-256，hex。理由见 schema：令牌是我们自己生成的 256 位随机数，不需要慢哈希 */
function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export interface CreatedToken {
  id: string;
  /** **只在这一刻出现一次**，之后库里只有哈希 */
  plaintext: string;
  visible: string;
}

export function createToken(input: {
  userId: string;
  name: string;
  scopes: readonly ScopeKey[];
  expiresAt?: number | null;
}): CreatedToken {
  const { plaintext, visible } = formatToken(randomBytes(32));
  const id = crypto.randomUUID().replace(/-/g, "");
  db.insert(apiTokens)
    .values({
      id,
      userId: input.userId,
      name: input.name.trim() || "未命名",
      visible,
      hash: hashToken(plaintext),
      scopes: normalizeScopes([...input.scopes]),
      expiresAt: input.expiresAt ?? null,
    })
    .run();
  return { id, plaintext, visible };
}

export interface TokenIdentity {
  tokenId: string;
  userId: string;
  scopes: ScopeKey[];
}

/**
 * 校验一把令牌。认不出返回 `null`。
 *
 * ─────────────────────────────────────────
 * 先看形状，再查库
 * ─────────────────────────────────────────
 *
 * 形状不对的连查询都不发：省一次数据库往返，也**少一条时序信息** ——
 * 「格式错的请求比格式对的快很多」本身就能被拿来试探。
 */
export function verifyToken(raw: unknown): TokenIdentity | null {
  if (!looksLikeToken(raw)) return null;

  const digest = hashToken(raw);
  const row = db.select().from(apiTokens).where(eq(apiTokens.hash, digest)).get();
  if (!row) return null;

  /*
   * 已经按哈希唯一索引找到了，这里再比一次是为了**常数时间比较**。
   *
   * 说实话这一步在 SHA-256 全等查完之后收益很小，但它便宜，
   * 而且它挡住的是下一个人把这段改成 `row.hash === digest` ——
   * 那才是真正会泄露信息的写法。
   */
  const a = Buffer.from(row.hash, "hex");
  const b = Buffer.from(digest, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  if (row.revokedAt !== null) return null;
  if (row.expiresAt !== null && row.expiresAt <= Date.now()) return null;

  /*
   * 记一次「用过了」。
   *
   * 这一列是**清理的唯一依据**：一把半年没动过的令牌十有八九是
   * 某次调试留下的，而它仍然能发消息。没有这一列的话，
   * 「哪些该撤掉」这个问题没有任何答案。
   */
  db.update(apiTokens).set({ lastUsedAt: Date.now() }).where(eq(apiTokens.id, row.id)).run();

  return {
    tokenId: row.id,
    userId: row.userId,
    scopes: normalizeScopes(row.scopes),
  };
}

export function revokeToken(id: string, userId: string, reason: string): boolean {
  const result = db
    .update(apiTokens)
    .set({ revokedAt: Date.now(), revokedReason: reason.slice(0, 200) })
    /*
     * 带上 userId：不带的话，知道别人令牌 id 的人就能替他撤销。
     * id 不是秘密 —— 它出现在列表页和审计日志里。
     */
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .run();
  return result.changes > 0;
}

export interface TokenRow {
  id: string;
  name: string;
  visible: string;
  scopes: ScopeKey[];
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
}

/** 一个人的令牌列表。**撤销过的也列出来** —— 那是他自己的操作记录 */
export function tokensOf(userId: string): TokenRow[] {
  return db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(desc(apiTokens.createdAt))
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      visible: r.visible,
      scopes: normalizeScopes(r.scopes),
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      expiresAt: r.expiresAt,
      revokedAt: r.revokedAt,
      revokedReason: r.revokedReason,
    }));
}

/* ── 逐群的发送授权 ────────────────────────────────────── */

export interface SendGrant {
  /** 这条授权自己的额度；null 的那一档跟着全局走 */
  perMinute: number | null;
  perHour: number | null;
  perDay: number | null;
}

/**
 * 这个人能往这个群发吗 —— 能的话把**这条授权自己的额度**一起带回来。
 *
 * 返回额度而不是只返回布尔：限流那一步紧接着就要用，
 * 分两次查的话中间会有一个「授权已经收回、额度还是旧的」的窗口。
 */
export function sendGrantFor(userId: string, convId: string): SendGrant | null {
  const row = db
    .select({
      perMinute: groupSendGrants.perMinute,
      perHour: groupSendGrants.perHour,
      perDay: groupSendGrants.perDay,
    })
    .from(groupSendGrants)
    .where(
      and(
        eq(groupSendGrants.userId, userId),
        eq(groupSendGrants.convId, convId),
        isNull(groupSendGrants.revokedAt),
      ),
    )
    .get();
  return row ?? null;
}

/** 他被授权了哪几个群 —— 界面和动态文档都要按这个列 */
export function grantedGroups(userId: string): string[] {
  return db
    .select({ convId: groupSendGrants.convId })
    .from(groupSendGrants)
    .where(and(eq(groupSendGrants.userId, userId), isNull(groupSendGrants.revokedAt)))
    .all()
    .map((r) => r.convId);
}

export function grantSend(input: {
  convId: string;
  userId: string;
  grantedBy: string;
  reason?: string;
  /** 这条授权自己的额度；不填就跟着全局走 */
  limits?: Partial<SendGrant>;
}): void {
  db.insert(groupSendGrants)
    .values({
      convId: input.convId,
      userId: input.userId,
      grantedBy: input.grantedBy,
      reason: input.reason?.slice(0, 200) ?? null,
      perMinute: input.limits?.perMinute ?? null,
      perHour: input.limits?.perHour ?? null,
      perDay: input.limits?.perDay ?? null,
      revokedAt: null,
    })
    /*
     * 再授一次要把 `revokedAt` 清掉 —— 否则「收回之后再给」
     * 会因为唯一索引静默失败，而界面上看起来像是给成功了。
     */
    .onConflictDoUpdate({
      target: [groupSendGrants.convId, groupSendGrants.userId],
      set: {
        revokedAt: null,
        grantedBy: input.grantedBy,
        reason: input.reason?.slice(0, 200) ?? null,
        perMinute: input.limits?.perMinute ?? null,
        perHour: input.limits?.perHour ?? null,
        perDay: input.limits?.perDay ?? null,
        createdAt: Date.now(),
      },
    })
    .run();
}

export function revokeSend(convId: string, userId: string): boolean {
  const result = db
    .update(groupSendGrants)
    .set({ revokedAt: Date.now() })
    .where(
      and(
        eq(groupSendGrants.convId, convId),
        eq(groupSendGrants.userId, userId),
        isNull(groupSendGrants.revokedAt),
      ),
    )
    .run();
  return result.changes > 0;
}

/* ── 限流与留痕 ────────────────────────────────────────── */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 这把令牌还能不能再发。
 *
 * 三个窗口各数一次。**失败的也算** —— 否则「试了一百次都失败」
 * 在限流上等于没发生，而那一百次每一次都真的打到了上游。
 */
export function sendAllowance(
  tokenId: string,
  grant?: SendGrant | null,
  now = Date.now(),
): LimitVerdict {
  const count = (since: number) =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(apiSends)
      .where(and(eq(apiSends.tokenId, tokenId), gte(apiSends.at, since)))
      .get()?.n ?? 0;

  return checkSendLimit(
    { minute: count(now - MINUTE), hour: count(now - HOUR), day: count(now - DAY) },
    // 授权上的额度只能收紧不能放宽 —— 见 effectiveLimits
    effectiveLimits(grant),
  );
}

/** 记一条发送。成功失败都记，理由见 `sendAllowance` 和 schema */
export function recordSend(input: {
  tokenId: string;
  userId: string;
  convId: string;
  /** **拼好署名之后的整条**，也就是群里真正看到的那一条 */
  text: string;
  ok: boolean;
  error?: string | null;
  msgSvrId?: string | null;
}): void {
  db.insert(apiSends)
    .values({
      id: crypto.randomUUID().replace(/-/g, ""),
      tokenId: input.tokenId,
      userId: input.userId,
      convId: input.convId,
      length: [...input.text].length,
      /*
       * 存的是拼好署名之后的整条。存正文的话，
       * 「署名那一行是不是真的加上了」就成了一件事后查不出来的事。
       */
      text: input.text,
      ok: input.ok,
      error: input.error?.slice(0, 200) ?? null,
      msgSvrId: input.msgSvrId ?? null,
      at: Date.now(),
    })
    .run();
}

/** 署名要用的名字 —— 站内昵称优先，没有就退回微信昵称 */
export function senderNameOf(userId: string): string {
  const row = db
    .select({ site: users.siteNickname, wx: users.wxNickname })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return (row?.site || row?.wx || "").trim();
}
