import { NextResponse } from "next/server";

import { RateLimitError, startBind } from "@/lib/auth/bind";
import { getSettingBool } from "@/lib/settings/store";
import { clientIp } from "@/lib/request";

export async function POST(request: Request) {
  if (!getSettingBool("site.registration_open", true)) {
    return NextResponse.json({ error: "暂未开放绑定" }, { status: 403 });
  }

  const ip = clientIp(request);

  /*
   * 带着上一次的 nonce 来的话，优先把那次绑定接回来（微信内置浏览器
   * 杀后台是常态）—— 能接回就不发新码，也不消耗取码限流的额度。
   * cookie 是 httpOnly 的，这里从请求头里解，与 status 路由同一套写法。
   */
  const resumeNonce = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("al_bind="))
    ?.slice("al_bind=".length);

  let result;
  try {
    result = startBind({ ip, resumeNonce });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { error: err.message },
        { status: 429, headers: { "Retry-After": String(err.retryAfterSeconds) } },
      );
    }
    throw err;
  }

  // nonce 是这次绑定会话的凭据，随 httpOnly cookie 下发，前端拿不到也改不了
  const response = NextResponse.json({
    code: result.code,
    expiresAt: result.expiresAt,
    fallbackAfterSeconds: result.fallbackAfterSeconds,
    groupPrefix: result.groupPrefix,
    resumed: result.resumed,
    issuedAt: result.issuedAt,
  });

  // 恢复时也重设一遍 —— 顺带把 maxAge 续上，让「关了再开」的窗口从现在重新起算
  response.cookies.set("al_bind", result.nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 900,
  });

  return response;
}
