import "server-only";

import { and, desc, eq, gt, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { loginAttempts, sessions } from "@/lib/db/schema";

/** 从 UA 里认出设备与浏览器。认不出就如实说「未知设备」，不瞎猜 */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "未知设备";
  const ua = userAgent;

  const os =
    /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /Mac OS X/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : "未知设备";

  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    // Safari 的 UA 里也有 Safari 字样，所以要放在最后判
    : /Safari\//.test(ua) ? "Safari"
    : /MicroMessenger/.test(ua) ? "微信内置浏览器"
    : null;

  return browser ? `${os} · ${browser}` : os;
}

export interface DeviceSession {
  id: string;
  device: string;
  ip: string | null;
  lastSeenAt: number;
  createdAt: number;
  current: boolean;
}

export function listSessions(userId: string, currentTokenHash?: string): DeviceSession[] {
  return db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, Date.now()),
      ),
    )
    .orderBy(desc(sessions.lastSeenAt))
    .all()
    .map((s) => ({
      id: s.id,
      device: s.deviceName ?? describeDevice(s.userAgent),
      ip: s.ip,
      lastSeenAt: s.lastSeenAt,
      createdAt: s.createdAt,
      current: Boolean(currentTokenHash && s.tokenHash === currentTokenHash),
    }));
}

export function listLoginHistory(userId: string, limit = 20) {
  return db
    .select()
    .from(loginAttempts)
    .where(eq(loginAttempts.userId, userId))
    .orderBy(desc(loginAttempts.createdAt))
    .limit(limit)
    .all()
    .map((a) => ({
      id: a.id,
      method: a.method,
      success: a.success,
      failureReason: a.failureReason,
      ip: a.ip,
      device: describeDevice(a.userAgent),
      createdAt: a.createdAt,
    }));
}
