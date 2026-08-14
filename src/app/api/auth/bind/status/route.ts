import { NextResponse } from "next/server";

import { checkBindStatus } from "@/lib/auth/bind";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { loginAttempts } from "@/lib/db/schema";
import { NekoBotError } from "@/lib/nekobot/client";
import { clientIp } from "@/lib/request";

export async function GET(request: Request) {
  const nonce = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("al_bind="))
    ?.slice("al_bind=".length);

  if (!nonce) {
    return NextResponse.json({ state: "expired" });
  }

  try {
    const status = await checkBindStatus(nonce);

    if (status.state !== "bound") {
      return NextResponse.json(status);
    }

    const ip = clientIp(request);

    const userAgent = request.headers.get("user-agent") ?? undefined;

    // 记进登录历史，否则安全页只看得到 Passkey 登录，漏掉一半
    db.insert(loginAttempts)
      .values({
        userId: status.userId,
        method: "bind_code",
        success: true,
        ip,
        userAgent,
      })
      .run();

    const token = createSession(status.userId, { ip, userAgent });
    await setSessionCookie(token);

    const response = NextResponse.json({
      state: "bound",
      wxId: status.wxId,
      isNewUser: status.isNewUser,
      // 新用户引导去注册 Passkey，之后不再依赖微信
      next: status.isNewUser ? "/onboarding" : "/",
    });
    response.cookies.delete("al_bind");
    return response;
  } catch (err) {
    // 隧道断了不等于验证失败，前端应该继续等而不是让用户重来
    if (err instanceof NekoBotError && err.isUpstreamDown) {
      return NextResponse.json({ state: "upstream_down" }, { status: 200 });
    }
    throw err;
  }
}
