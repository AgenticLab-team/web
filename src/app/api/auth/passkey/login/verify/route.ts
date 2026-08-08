import { NextResponse } from "next/server";

import { completeAuthentication } from "@/lib/auth/passkey";
import { tooManyLoginAttempts } from "@/lib/auth/ratelimit";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { clientIp } from "@/lib/request";

export async function POST(request: Request) {
  const ip = clientIp(request);
  const limited = tooManyLoginAttempts(ip);
  if (limited) {
    return NextResponse.json(
      { error: limited.message },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
    );
  }

  const body = await request.json().catch(() => null);
  if (!body?.response) return NextResponse.json({ error: "请求格式不对" }, { status: 400 });

  const userAgent = request.headers.get("user-agent") ?? undefined;
  const result = await completeAuthentication(body.response, { ip, userAgent });

  if (!result.ok || !result.userId) {
    return NextResponse.json({ error: result.error }, { status: 401 });
  }

  const token = createSession(result.userId, { ip, userAgent });
  await setSessionCookie(token);
  return NextResponse.json({ ok: true, next: "/" });
}
