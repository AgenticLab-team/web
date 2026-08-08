import { NextResponse } from "next/server";

import { startBind } from "@/lib/auth/bind";
import { getSettingBool } from "@/lib/settings/store";

export async function POST(request: Request) {
  if (!getSettingBool("site.registration_open", true)) {
    return NextResponse.json({ error: "暂未开放绑定" }, { status: 403 });
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    undefined;

  const result = startBind({ ip });

  // nonce 是这次绑定会话的凭据，随 httpOnly cookie 下发，前端拿不到也改不了
  const response = NextResponse.json({
    code: result.code,
    expiresAt: result.expiresAt,
    fallbackAfterSeconds: result.fallbackAfterSeconds,
    groupPrefix: result.groupPrefix,
  });

  response.cookies.set("al_bind", result.nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 900,
  });

  return response;
}
