import { NextResponse } from "next/server";

import { checkBindStatus } from "@/lib/auth/bind";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { NekoBotError } from "@/lib/nekobot/client";

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

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      request.headers.get("x-real-ip") ??
      undefined;

    const token = createSession(status.userId, {
      ip,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
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
