import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt, isNull } from "drizzle-orm";
import { cookies } from "next/headers";

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

  return token;
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
  const store = await cookies();
  const preview = resolvePreview(store.get(PREVIEW_COOKIE)?.value);
  if (preview) return preview.subject;
  return resolveSession(store.get(SESSION_COOKIE)?.value);
}

/** 当前是不是在预览态；不是则返回 null */
export async function currentPreview(): Promise<ActivePreview | null> {
  const store = await cookies();
  return resolvePreview(store.get(PREVIEW_COOKIE)?.value);
}

/** 真实登录的那个人 —— 预览态下也是他，不受影响 */
export async function getRealUser(): Promise<CurrentUser | null> {
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
