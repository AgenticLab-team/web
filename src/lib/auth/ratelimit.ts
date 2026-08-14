import "server-only";

import { and, count, eq, gt } from "drizzle-orm";

import { db } from "@/lib/db";
import { loginAttempts } from "@/lib/db/schema";
import { getSettingInt } from "@/lib/settings/store";

export interface RateLimitVerdict {
  message: string;
  retryAfterSeconds: number;
}

/**
 * 登录尝试限流。
 *
 * 与绑定码限流一样按 IP 计，所以阈值不能按「每人」的直觉定 ——
 * 国内运营商大量用 NAT，一个出口后面可能有几十个群友。
 * 只统计**失败**的尝试：成功登录不该消耗别人的配额。
 */
export function tooManyLoginAttempts(ip: string): RateLimitVerdict | null {
  /*
   * 这里原来有一句 `if (!ip) return null` —— **拿不到 IP 就不限流**。
   *
   * 失效方向是开着的：哪天前面换个反向代理、或者有人直连 node 的端口，
   * 全站按 IP 的限流会一起消失，而没有任何地方会报错。
   *
   * 现在 `clientIp()` 保证有值（拿不到时是 `UNKNOWN_IP` 哨兵），
   * 那种情况下所有请求挤在同一个桶里 —— 会互相挤，但不会没有闸。
   * 宁可误伤也不能失效，这是限流唯一站得住的失效方向。
   */

  const max = getSettingInt("auth.login.max_attempts_per_hour", 20);
  const failures =
    db
      .select({ n: count() })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.ip, ip),
          eq(loginAttempts.success, false),
          gt(loginAttempts.createdAt, Date.now() - 3_600_000),
        ),
      )
      .get()?.n ?? 0;

  if (failures < max) return null;
  return { message: `尝试过于频繁，请稍后再试`, retryAfterSeconds: 900 };
}
