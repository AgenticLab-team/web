import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt, isNull } from "drizzle-orm";
import { cookies } from "next/headers";

import { db } from "@/lib/db";
import { sessions, users } from "@/lib/db/schema";
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

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value);
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
