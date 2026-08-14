import "server-only";

import { and, count, eq, gt } from "drizzle-orm";

import { db } from "@/lib/db";
import { deviceCodes } from "@/lib/db/schema";
import { getSettingInt } from "@/lib/settings/store";

/**
 * 「要一串登录码」这个动作的限流。
 *
 * ═════════════════════════════════════════
 * 它护的不是登录，是**别人的登录**
 * ═════════════════════════════════════════
 *
 * 不限的话，任何人都能不停地灌 `/auth/device/start`，
 * 把 `device_codes` 撑到很大。表一大，生成用户码时撞车的概率
 * 跟着涨，而撞车的表现是 —— **一个毫不相干的人偶尔登录失败**。
 *
 * 也就是说，这里不限流，疼的不是刷的人。
 *
 * ─────────────────────────────────────────
 * 阈值按 IP，所以不能按「每人」的直觉定
 * ─────────────────────────────────────────
 *
 * 和 `lib/auth/ratelimit.ts` 那条同一个理由：国内运营商大量用 NAT，
 * 一个出口后面可能有几十个群友。而这里还多一种情况：
 * **SSH 网关上所有人的请求都从同一个 IP 出去** ——
 * 那台机器的出口后面是全部 SSH 用户。
 *
 * 所以阈值定得比登录那条宽得多，且做成可配的。
 *
 * ─────────────────────────────────────────
 * 成功换走令牌的那些**不占额度**
 * ─────────────────────────────────────────
 *
 * 换到令牌的那一行会被直接删掉（见 `db/schema/device.ts`），
 * 所以这里数出来的天然只有「要了码却没用」的那些。
 *
 * 这一条不是巧合，是必须的：数全部的话，一台 SSH 网关正常服务
 * 几十个人就会把自己卡死 —— 他们每个人都成功登录过，
 * 而成功恰恰是这个接口该鼓励的事。
 */
export interface DeviceRateVerdict {
  message: string;
  retryAfterSeconds: number;
}

export function tooManyDeviceStarts(ip: string, now = Date.now()): DeviceRateVerdict | null {
  /*
   * 这里原来有一句 `if (!ip) return null`。见 `lib/auth/ratelimit.ts`
   * 里同一处的说明：限流失效的方向必须是「误伤」，不能是「没闸」。
   *
   * 这个接口尤其不能失效 —— 它是全站唯一一个**未鉴权就能写库**的
   * 公网端点（设备码流程本来就从没有凭证开始），而限流是它唯一的闸。
   */

  const max = getSettingInt("tui.device.max_starts_per_hour", 60);
  const recent =
    db
      .select({ n: count() })
      .from(deviceCodes)
      .where(
        and(
          eq(deviceCodes.requestIp, ip),
          gt(deviceCodes.createdAt, now - 3_600_000),
        ),
      )
      .get()?.n ?? 0;

  if (recent < max) return null;
  return {
    message: "这个地址要码要得太频繁了，等一会儿再试",
    retryAfterSeconds: 300,
  };
}
