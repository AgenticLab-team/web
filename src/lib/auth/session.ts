import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { cookies } from "next/headers";

import { currentApiCaller } from "@/lib/api-tokens/as-caller";
import { db } from "@/lib/db";
import { sessions, users } from "@/lib/db/schema";
import { resolvePreview, type ActivePreview } from "@/lib/rbac/preview";
import { PREVIEW_COOKIE, PREVIEW_WRITE_BLOCKED } from "@/lib/rbac/preview-rules";
import { getSettingInt } from "@/lib/settings/store";

export const SESSION_COOKIE = "al_session";

/** 库里只存哈希：数据库泄露不等于会话被盗 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionContext {
  ip?: string;
  userAgent?: string;
  deviceName?: string;
}

/**
 * 一个人同时能有几个活会话。
 *
 * ─────────────────────────────────────────
 * 不设上限的后果不是「安全」，是「看不清」
 * ─────────────────────────────────────────
 *
 * 每次登录都新建一行，而没有任何地方合并或回收 ——
 * 线上有人三天里攒了 **25 个**活会话。
 *
 * 「登录设备」那一页因此变成一串认不出来的条目：
 * 二十多行「Android · 微信」，谁也说不清哪个是自己现在这台、
 * 哪个是上个月在别人手机上登的。**一个说不清的列表等于没有列表** ——
 * 而这一页存在的唯一理由就是让人发现不该在的那一台。
 *
 * 超出上限时踢掉**最久没露面**的那些，不是最早创建的：
 * 一台天天在用的老设备比一台上周登过一次的新设备更该留着。
 */
function enforceSessionCap(userId: string, keep: number): void {
  const live = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, Date.now())),
    )
    .orderBy(desc(sessions.lastSeenAt))
    .all();

  const extra = live.slice(keep);
  if (extra.length === 0) return;

  db.update(sessions)
    .set({
      revokedAt: Date.now(),
      // 记明白是谁踢的 —— 用户在登录历史里看到「被下线」时要答得上来为什么
      revokedBy: "system:session-cap",
      revokeReason: "session_cap",
    })
    .where(inArray(sessions.id, extra.map((s) => s.id)))
    .run();
}

export function createSession(userId: string, ctx: SessionContext = {}): string {
  const token = randomBytes(32).toString("base64url");
  const ttlDays = getSettingInt("auth.session.ttl_days", 30);

  db.insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      deviceName: ctx.deviceName,
      expiresAt: Date.now() + ttlDays * 86_400_000,
    })
    .run();

  /*
   * 先插入再收口，不是反过来。
   *
   * 反过来的话，上限是 N 时人只能有 N-1 个 —— 而且刚建的这一个
   * `lastSeenAt` 最新，永远不会被自己踢掉，所以顺序在这里是安全的。
   */
  enforceSessionCap(userId, getSettingInt("auth.session.max_per_user", 10));

  return token;
}

/**
 * 清掉过期和早就撤销的会话行。
 *
 * **在此之前没有任何地方删过它们。** 30 天 TTL、一百多人，
 * 一年下来是几万行没人看的数据 —— 而且每一行都带着 IP 和 UA，
 * 那是「谁在哪儿上过网」的记录，留着不看等于白留一份可泄露的东西。
 *
 * 撤销的多留一段时间：用户点了「下线这台」之后，
 * 「登录历史」还要能说出那台设备什么时候被下线、是谁下的。
 */
export function pruneSessions(now = Date.now()): number {
  const graceDays = getSettingInt("auth.session.revoked_keep_days", 30);
  return db
    .delete(sessions)
    .where(
      or(
        lt(sessions.expiresAt, now),
        and(isNotNull(sessions.revokedAt), lt(sessions.revokedAt, now - graceDays * 86_400_000)),
      ),
    )
    .run().changes;
}

export type CurrentUser = typeof users.$inferSelect;

export function resolveSession(token: string | undefined): CurrentUser | null {
  if (!token) return null;

  const row = db
    .select({ user: users, sessionId: sessions.id })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, Date.now()),
      ),
    )
    .get();

  if (!row) return null;
  // 封禁立即生效，不等会话过期
  if (row.user.status === "banned" || row.user.status === "deleted") return null;

  db.update(sessions)
    .set({ lastSeenAt: Date.now() })
    .where(eq(sessions.id, row.sessionId))
    .run();

  return row.user;
}

/**
 * 当前登录的人。**预览态下返回的是被预览的那个人。**
 *
 * 这是整站唯一的身份入口，所以预览必须在这里接进去 ——
 * 接在别处就意味着有些页面切了视角、有些没切，
 * 而一个只切了一半的视角比没有更容易得出错误结论。
 *
 * 真实身份没有丢，在 currentPreview() 里 —— 审计、写操作拦截
 * 都用那个，永远记在真人头上。
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  /*
   * 开放 API 的调用先在这里认出来。
   *
   * ─────────────────────────────────────────
   * 它**不读 cookie**，所以 `auth.ts` 那条红线仍然成立
   * ─────────────────────────────────────────
   *
   * 那条红线是「令牌不进网页这条路，cookie 不进 API 那条路」。
   * 这里是后半句的实现细节：一次 API 调用**根本不去看 cookie**，
   * 而不是「看了但优先用令牌」。
   *
   * 反方向也没被打开：这个存储只在 `src/app/api/v1/**` 里被设上
   * （有守卫盯着，见 `lib/api-tokens/as-caller.ts`），
   * 浏览器发起的请求永远看到空存储。
   *
   * 这么做换来的是：打卡、收藏、报名、下单、后台那一百来个管理动作
   * 一个字都不用改，就能被令牌调用 —— 而它们的权限判定、审计、
   * 限流逐字还是网页那一套。另写一份「API 版」的话，
   * 两份规则迟早分叉，而分叉的方向永远是 API 那份更宽松。
   */
  const caller = currentApiCaller();
  if (caller) return caller.user;

  const store = await cookies();
  const preview = resolvePreview(store.get(PREVIEW_COOKIE)?.value);
  if (preview) return preview.subject;
  return resolveSession(store.get(SESSION_COOKIE)?.value);
}

/**
 * 当前是不是在预览态；不是则返回 null。
 *
 * **API 调用永远不是预览态** —— 预览是一个 cookie，而令牌那条路
 * 不读 cookie。写在这里而不是靠「反正它读不到」：
 * 后者是一个碰巧成立的事实，前者是一条判定。
 */
export async function currentPreview(): Promise<ActivePreview | null> {
  if (currentApiCaller()) return null;
  const store = await cookies();
  return resolvePreview(store.get(PREVIEW_COOKIE)?.value);
}

/** 真实登录的那个人 —— 预览态下也是他，不受影响 */
export async function getRealUser(): Promise<CurrentUser | null> {
  /*
   * API 调用下，「当前的人」和「真实的人」是同一个：
   * 令牌属于一个具体的账号，中间没有预览这一层可以偏移。
   */
  const caller = currentApiCaller();
  if (caller) return caller.user;

  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value);
}

/**
 * 预览态下写操作一律拦下。
 *
 * 放在这里而不是各个 action 里自己判断，是因为**「靠自觉一定会漏」**——
 * 漏掉一处的后果是：管理员以别人的身份写了数据，
 * 而审计日志记的是被预览的那个人。从那以后这个站的日志一条都不能信。
 *
 * requireAdmin 里已经调了它，覆盖了后台的全部写入口；
 * 后台之外的 server action 由 tests/preview-coverage.test.ts 逐个核对。
 */
export async function assertNotPreviewing(): Promise<void> {
  const preview = await currentPreview();
  if (preview) throw new PreviewWriteError();
}

export class PreviewWriteError extends Error {
  constructor() {
    super(PREVIEW_WRITE_BLOCKED);
    this.name = "PreviewWriteError";
  }
}

export async function setSessionCookie(token: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: getSettingInt("auth.session.ttl_days", 30) * 86_400,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function revokeCurrentSession(reason: "logout" | "admin" = "logout") {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    db.update(sessions)
      .set({ revokedAt: Date.now(), revokeReason: reason })
      .where(eq(sessions.tokenHash, hashToken(token)))
      .run();
  }
  await clearSessionCookie();
}

/** 封禁、改密码时调用：把这个人所有设备踢下线 */
export function revokeAllSessions(
  userId: string,
  reason: "admin" | "credential_change" | "ban",
  actorId?: string,
) {
  return db
    .update(sessions)
    .set({ revokedAt: Date.now(), revokedBy: actorId, revokeReason: reason })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .run();
}
