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
export function tooManyLoginAttempts(ip?: string): RateLimitVerdict | null {
  if (!ip) return null;

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
