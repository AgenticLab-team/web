import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";

export const dynamic = "force-dynamic";

/**
 * 我是谁。
 *
 * **只给自己的东西**，而且只给用户自己在界面上本来就看得到的那些 ——
 * 令牌不是一条通往更多数据的近路，它只是换了一种敲门方式。
 *
 * 特别地：不给 `wx_id`。它是微信那一侧的身份，拿着它可以直接加人，
 * 而这个接口的返回值会被打进日志、存进别人的脚本里。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["me:read"]);
  if (!auth.ok) return auth.response;

  const { user } = auth.caller;
  return NextResponse.json({
    id: user.id,
    name: user.siteNickname ?? user.wxNickname ?? null,
    status: user.status,
    created_at: user.createdAt,
  });
}
