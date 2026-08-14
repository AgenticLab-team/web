import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, desc, eq, gte, isNull, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { resolveDisplayName } from "@/lib/users/display-name";
import { apiSends, apiTokens, groupSendGrants, groups, users } from "@/lib/db/schema";

import {
  checkSendLimit,
  effectiveLimits,
  formatToken,
  looksLikeToken,
  normalizeScopes,
  SEND_LIMIT,
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
  /**
   * 哪个 OAuth 应用换来的。自己在页面上建的不传。
   *
   * 这一个可选参数就是整套 OAuth 复用这条路的全部代价 ——
   * 验令牌、限流、留痕、撤销一个字都不用改。
   */
  appId?: string | null;
  /**
   * 怎么来的。默认 `manual`（人在网页上自己建的）。
   *
   * 设备码登录换来的填 `device` / `ssh` —— 后者的明文躺在
   * SSH 网关那台机器上，而「一次性撤掉那台机器上的全部令牌」
   * 这个动作只能靠这一列来做。见 `db/schema/api.ts` 上那段。
   */
  source?: "manual" | "device" | "ssh";
  deviceLabel?: string | null;
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
      appId: input.appId ?? null,
      source: input.source ?? "manual",
      deviceLabel: input.deviceLabel ?? null,
    })
    .run();
  return { id, plaintext, visible };
}

/**
 * 把 SSH 网关签出的令牌**全部**作废。
 *
 * ─────────────────────────────────────────
 * 它是网关被怀疑失守时第一个要按的按钮
 * ─────────────────────────────────────────
 *
 * 网关那台机器上放着一批别人的令牌明文（`TUI.md` 第四节）。
 * 怀疑它失守的时候，逐个去找「哪些是那台机器上的」是做不到的 ——
 * 令牌名字是人起的，而且那批令牌散在几十个人名下。
 *
 * 所以按 `source` 一刀切。代价是所有 SSH 用户要重新登录一次，
 * 而那正是这个动作应有的代价。
 */
export function revokeAllSshTokens(reason: string): number {
  const result = db
    .update(apiTokens)
    .set({ revokedAt: Date.now(), revokedReason: reason.slice(0, 200) })
    .where(and(eq(apiTokens.source, "ssh"), isNull(apiTokens.revokedAt)))
    .run();
  return result.changes;
}

/**
 * 同上，但只撤**一个人自己的**。
 *
 * 两个函数而不是一个带可选参数的，理由是那个可选参数一旦漏传，
 * 一次「撤销我自己在网关上的令牌」就会变成**把所有人踢下线**。
 * 而它不会报错。
 */
export function revokeAllSshTokensOf(userId: string, reason: string): number {
  const result = db
    .update(apiTokens)
    .set({ revokedAt: Date.now(), revokedReason: reason.slice(0, 200) })
    .where(
      and(eq(apiTokens.userId, userId), eq(apiTokens.source, "ssh"), isNull(apiTokens.revokedAt)),
    )
    .run();
  return result.changes;
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
 * 这个人还能不能再往这个群发。
 *
 * ═════════════════════════════════════════
 * 按**人**数，不按令牌数
 * ═════════════════════════════════════════
 *
 * 按令牌数是很自然的写法（限流参数就挂在令牌上），但它是错的：
 * 一个人可以建十把令牌，于是他有十份额度 —— 而上游那份
 * 20 条/分钟是**全站共用**的，等于一个人就能把整站的额度吃光，
 * 而且完全不用绕过任何东西，界面上就有「新建令牌」按钮。
 *
 * 令牌是「同一个人的另一把钥匙」，不是「另一个人」。
 * 网页上发的那条路更是连令牌都没有。
 *
 * ─────────────────────────────────────────
 * 两道闸，管的是两件事
 * ─────────────────────────────────────────
 *
 * ① **全局**：这个人一共发了多少，用全站默认额度 —— 护的是上游那份共用配额
 * ② **这个群**：他往这个群发了多少，用这条授权自己的额度 ——
 *    护的是「站长说他一天只能往这个群发 5 条」这件事
 *
 * 只留 ① 的话，站长在授权上调紧的额度形同虚设。
 * 只留 ② 的话，他被授权了五个群就有五份额度。
 *
 * 三个窗口各数一次。**失败的也算** —— 否则「试了一百次都失败」
 * 在限流上等于没发生，而那一百次每一次都真的打到了上游。
 */
export function sendAllowance(
  userId: string,
  convId: string,
  grant?: SendGrant | null,
  now = Date.now(),
): LimitVerdict {
  const countWhere = (extra: SQL | undefined, since: number) =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(apiSends)
      .where(and(eq(apiSends.userId, userId), extra, gte(apiSends.at, since)))
      .get()?.n ?? 0;

  const windows = (extra: SQL | undefined) => ({
    minute: countWhere(extra, now - MINUTE),
    hour: countWhere(extra, now - HOUR),
    day: countWhere(extra, now - DAY),
  });

  // ① 全站默认额度，跨群一起数
  const global = checkSendLimit(windows(undefined), SEND_LIMIT);
  if (!global.allowed) return global;

  // ② 这条授权自己的额度，只数这个群。effectiveLimits 保证它不会比 ① 松
  return checkSendLimit(windows(eq(apiSends.convId, convId)), effectiveLimits(grant));
}

/** 记一条发送。成功失败都记，理由见 `sendAllowance` 和 schema */
export function recordSend(input: {
  /** 网页上发的传 null */
  tokenId: string | null;
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

export interface SendLogRow {
  /** 谁发的（已经解析成人名）—— 显示 id 等于没显示 */
  userName: string;
  id: string;
  /** 网页上发的是 null */
  tokenId: string | null;
  tokenName: string | null;
  userId: string;
  convId: string;
  convName: string | null;
  text: string | null;
  ok: boolean;
  error: string | null;
  at: number;
}

/**
 * 代发日志。
 *
 * ═════════════════════════════════════════
 * 这是「机器人到底说了什么」的唯一答案
 * ═════════════════════════════════════════
 *
 * 消息署名是机器人，群里的人看不出是谁让它说的 ——
 * 站长看这一页，看的正是那个。
 *
 * `userId` 传 null 就是全站视角（站长用），传具体的人就是他自己那一份。
 * **不给「看别人的」这个中间态** —— 要么是自己的，要么是管理员；
 * 中间那一档没有任何合理的使用场景，只会变成一个越权的入口。
 */
export interface SendLogQuery {
  /**
   * 谁发的。**null = 全站**，只有管理页能这么传。
   *
   * 保留成必填参数（而不是可选）是有意的：写成可选的话，
   * 「我的」那一页少传一个字段就会把所有人的代发内容列出来 ——
   * 而那一页看起来一切正常，没有任何地方会报错。
   */
  userId: string | null;
  /** 只看某个群 */
  convId?: string | null;
  /** 只看成功的 / 只看失败的 */
  status?: "all" | "ok" | "failed";
  /** 在正文里搜。代发内容是要能审计的，搜不了等于没存 */
  query?: string | null;
  limit?: number;
  offset?: number;
}

/**
 * 代发日志。**带总数一起回**。
 *
 * 不回总数的话，分页只能做成「还有没有下一页」——
 * 而站长在这一页要回答的是「他一共代发过多少条」，
 * 那个问题没有总数就答不了。
 */
export function sendLog(input: SendLogQuery): { rows: SendLogRow[]; total: number } {
  const conditions = [
    input.userId ? eq(apiSends.userId, input.userId) : undefined,
    input.convId ? eq(apiSends.convId, input.convId) : undefined,
    input.status === "ok" ? eq(apiSends.ok, true) : undefined,
    input.status === "failed" ? eq(apiSends.ok, false) : undefined,
    /*
     * 正文搜索走 LIKE。
     *
     * 这张表是审计用的，量不大（一条代发一行，而额度是每天几十条），
     * 所以一次扫描比再建一套 FTS 便宜得多 —— 后者要多一张表、
     * 多一处同步，而同步漏掉的那些行会**安静地搜不到**。
     *
     * `%` 和 `_` 先转义掉，否则搜一个下划线等于匹配任意字符。
     */
    input.query?.trim()
      ? sql`${apiSends.text} LIKE ${"%" + escapeLike(input.query.trim()) + "%"} ESCAPE '\\'`
      : undefined,
  ].filter(Boolean);

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const total =
    db.select({ n: sql<number>`count(*)` }).from(apiSends).where(where).get()?.n ?? 0;

  const rows = db
    .select({
      id: apiSends.id,
      tokenId: apiSends.tokenId,
      tokenName: apiTokens.name,
      userId: apiSends.userId,
      /*
       * 名字也一起取回来。
       *
       * 全站那一页原来显示的是 `01JABC…` 这种账号 id —— 没有人认得出
       * 那是谁，而这一页存在的**全部意义**就是「谁借机器人的嘴说了什么」。
       * 授权表单已经因为同一个理由改成了从人名里选，日志这边漏了。
       *
       * 两列都取：站内昵称优先，没有就退回微信昵称 —— 和代发署名用的
       * 是同一条口径（senderNameOf），所以日志里的名字和群里看到的一致。
       */
      userName: users.siteNickname,
      userWxName: users.wxNickname,
      userWxId: users.wxId,
      convId: apiSends.convId,
      convName: groups.name,
      text: apiSends.text,
      ok: apiSends.ok,
      error: apiSends.error,
      at: apiSends.at,
    })
    .from(apiSends)
    .leftJoin(apiTokens, eq(apiTokens.id, apiSends.tokenId))
    .leftJoin(groups, eq(groups.convId, apiSends.convId))
    .leftJoin(users, eq(users.id, apiSends.userId))
    .where(where)
    .orderBy(desc(apiSends.at))
    .limit(input.limit ?? 50)
    .offset(input.offset ?? 0)
    .all();

  return {
    rows: rows.map(({ userName, userWxName, userWxId, ...rest }) => ({
      ...rest,
      // 走统一解析：people.display_name 的存量数据里混着 wx_id
      userName: resolveDisplayName([userName, userWxName], {
        wxId: userWxId,
        fallback: "成员",
      }),
    })),
    total,
  };
}

/** LIKE 里的通配符要转义 —— 不转的话搜 `_` 等于匹配任意一个字符 */
function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** 一把令牌最近用掉了多少额度 —— 界面上要能回答「我还能发几条」 */
export function usageOf(userId: string, now = Date.now()): { minute: number; hour: number; day: number } {
  const count = (since: number) =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(apiSends)
      .where(and(eq(apiSends.userId, userId), gte(apiSends.at, since)))
      .get()?.n ?? 0;
  return { minute: count(now - MINUTE), hour: count(now - HOUR), day: count(now - DAY) };
}

export interface GrantRow {
  convId: string;
  convName: string | null;
  userId: string;
  userName: string | null;
  grantedBy: string;
  reason: string | null;
  perMinute: number | null;
  perHour: number | null;
  perDay: number | null;
  createdAt: number;
}

/** 所有还生效的逐群发送授权 —— 站长那一页要列全 */
export function allGrants(): GrantRow[] {
  return db
    .select({
      convId: groupSendGrants.convId,
      convName: groups.name,
      userId: groupSendGrants.userId,
      userName: users.siteNickname,
      wxName: users.wxNickname,
      grantedBy: groupSendGrants.grantedBy,
      reason: groupSendGrants.reason,
      perMinute: groupSendGrants.perMinute,
      perHour: groupSendGrants.perHour,
      perDay: groupSendGrants.perDay,
      createdAt: groupSendGrants.createdAt,
    })
    .from(groupSendGrants)
    .leftJoin(groups, eq(groups.convId, groupSendGrants.convId))
    .leftJoin(users, eq(users.id, groupSendGrants.userId))
    .where(isNull(groupSendGrants.revokedAt))
    .orderBy(desc(groupSendGrants.createdAt))
    .all()
    .map(({ wxName, ...r }) => ({ ...r, userName: r.userName ?? wxName }));
}
