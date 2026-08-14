import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-tokens/auth";
import { env } from "@/lib/env";
import { clientIp } from "@/lib/request";
import { formatUserCode, sanitizeFingerprint, describeDevice } from "@/lib/tui/device-rules";
import { startDevice } from "@/lib/tui/device";
import { tooManyDeviceStarts } from "@/lib/tui/device-ratelimit";

export const dynamic = "force-dynamic";

/**
 * 终端客户端要一串登录码。
 *
 * ═════════════════════════════════════════
 * 这是 `/api/v1` 下**唯一两条不过 `authenticate()` 的路由**之一
 * ═════════════════════════════════════════
 *
 * 显而易见的理由：这一步的目的就是拿到令牌，要求先有令牌是循环的。
 *
 * 但「不鉴权」在这个目录下是一件需要被单独盯住的事 ——
 * `tests/api-surface.test.ts` 有一条守卫要求这里每个路由都先鉴权，
 * 而这两条在那份守卫里是**列名放行**的，不是靠模式匹配漏过去的。
 * 加第三条不鉴权的路由要去改那份名单，改的时候会被迫写清楚为什么。
 *
 * ─────────────────────────────────────────
 * 它不发账号，一行都不写
 * ─────────────────────────────────────────
 *
 * 这条路径上没有 `createSession`，也没有 `insert(users)`。
 * 它做的全部事情是「记下有一台设备想登录」——
 * 真正决定身份的是网页那一侧一个**已经登录的人**按下的同意。
 */
export async function POST(request: Request) {
  const ip = clientIp(request) ?? null;

  /*
   * 限流按 IP。
   *
   * 不限的话，任何人都能不停地灌这个接口，把 `device_codes` 表撑大 ——
   * 而表一大，`startDevice` 里那个「用户码撞车重试」就会越来越容易
   * 触发，症状是**别人偶尔登录失败**。也就是说这里不限流，
   * 疼的是无关的人。
   */
  const limited = tooManyDeviceStarts(ip);
  if (limited) {
    return apiError(429, "rate_limited", limited.message, {
      "Retry-After": String(limited.retryAfterSeconds),
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_json", "请求体不是合法的 JSON");
  }

  const raw = (body ?? {}) as Record<string, unknown>;
  /*
   * `source` 只认这两个值，而且**默认是 cli**。
   *
   * 反过来（默认 ssh）看起来更保守，其实更糟：ssh 那一档不许申请
   * `groups:send`，于是一个本地终端漏传字段时会拿到一把
   * 少了权限的令牌，而他要到真的去发消息那一刻才发现 ——
   * 那时候错误信息是「缺少权限」，指向的是一个他从没做过的选择。
   */
  const source = raw.source === "ssh" ? "ssh" : "cli";
  const fingerprint = sanitizeFingerprint(raw.fingerprint);

  const started = startDevice({
    source,
    label: describeDevice(fingerprint),
    ip,
    scopes: raw.scopes,
    sshKeyFingerprint: typeof raw.ssh_key === "string" ? raw.ssh_key.slice(0, 200) : null,
  });

  return NextResponse.json({
    /** 显示给人看的那一串，已经带上连字符 */
    user_code: formatUserCode(started.userCode),
    /** 终端自己揣着，别打到屏幕上 */
    device_code: started.deviceCode,
    verification_uri: `${env.site.url}/link`,
    /*
     * 直接把码拼进地址里的那一版也给出来。
     *
     * 终端能画二维码，而扫码之后还要手动输八位字符的话，
     * 二维码就只省了「打开网址」这一步 —— 也就是没省。
     *
     * 安全上的代价是这串码会进浏览器历史。可以接受：
     * 它 10 分钟就过期，而且单凭它换不到令牌（换令牌只认 device_code）。
     */
    verification_uri_complete: `${env.site.url}/link?code=${formatUserCode(started.userCode)}`,
    interval: started.interval,
    expires_in: Math.floor((started.expiresAt - Date.now()) / 1000),
    scopes: started.scopes,
  });
}
