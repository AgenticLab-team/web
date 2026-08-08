import { NextResponse } from "next/server";

import { buildAuthenticationOptions } from "@/lib/auth/passkey";
import { tooManyLoginAttempts } from "@/lib/auth/ratelimit";
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

  return NextResponse.json(await buildAuthenticationOptions(ip));
}
