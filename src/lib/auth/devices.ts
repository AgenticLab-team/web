import "server-only";

import { and, desc, eq, gt, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { loginAttempts, sessions } from "@/lib/db/schema";

/**
 * 从 UA 里认出设备与浏览器。认不出就如实说「未知设备」，不瞎猜。
 *
 * ─────────────────────────────────────────
 * 内嵌浏览器必须**排在前面**判
 * ─────────────────────────────────────────
 *
 * 它们的 UA 里全都带着 `Chrome/` 或 `Safari/` —— 安卓微信是
 * `… Chrome/132 … Mobile Safari/537.36 … MicroMessenger/8.0.32`。
 * 把 `MicroMessenger` 放在 Chrome 后面判，它永远轮不到。
 *
 * 这不是假设：线上 65 个来自微信的会话里，**47 个被显示成了 Chrome**。
 * 而微信是这个社群绝大多数人进站的方式 ——
 * 「登录设备」那一页因此几乎认不出真实入口。
 *
 * 顺序在这里是**语义**，不是风格：越具体的越靠前。
 * 企业微信的 UA 里同时带 `wxwork` 和 `MicroMessenger`，
 * 所以它还要排在微信前面。
 */
const IN_APP: readonly { test: RegExp; label: string }[] = [
  // 企业微信同时带 MicroMessenger，必须排在微信之前
  { test: /wxwork/i, label: "企业微信" },
  { test: /MicroMessenger/, label: "微信" },
  { test: /DingTalk/i, label: "钉钉" },
  { test: /Lark|Feishu/i, label: "飞书" },
  // QQ 内置浏览器是 `QQ/8.9.x`，QQ 浏览器是 `MQQBrowser/` —— 两个不是一回事
  { test: /\bQQ\/[\d.]/, label: "QQ" },
  { test: /MQQBrowser/, label: "QQ 浏览器" },
  { test: /Quark/i, label: "夸克" },
  { test: /UCBrowser/i, label: "UC" },
];

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

  const inApp = IN_APP.find((b) => b.test.test(ua));

  const browser =
    inApp?.label
    ?? (/Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    // Safari 放在最后：Chrome 的 UA 里也带 Safari 字样
    : /Safari\//.test(ua) ? "Safari"
    : null);

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

/**
 * 最近被「设备太多」自动下线的。
 *
 * 不说的话，用户看到的是一台设备**凭空消失** ——
 * 而在一个安全页面上，凭空消失的设备只会让人怀疑被盗号了。
 * 自动做的事必须自己说出来。
 */
export function recentAutoRevoked(
  userId: string,
  withinDays = 7,
  now = Date.now(),
): { count: number; latestAt: number } | null {
  const rows = db
    .select({ revokedAt: sessions.revokedAt })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.revokeReason, "session_cap"),
        gt(sessions.revokedAt, now - withinDays * 86_400_000),
      ),
    )
    .all();

  if (rows.length === 0) return null;
  return {
    count: rows.length,
    latestAt: Math.max(...rows.map((r) => r.revokedAt ?? 0)),
  };
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
