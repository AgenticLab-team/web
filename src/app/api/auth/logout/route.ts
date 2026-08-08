import { NextResponse } from "next/server";

import { revokeCurrentSession } from "@/lib/auth/session";
import { env } from "@/lib/env";

/**
 * 退出登录。用 GET 是为了能直接做成链接 —— 但因此必须只撤销当前这一个会话，
 * 不做任何其它副作用，否则会被跨站的 <img src> 之类触发。
 */
export async function GET() {
  await revokeCurrentSession("logout");
  return NextResponse.redirect(new URL("/", env.site.url));
}

export async function POST() {
  await revokeCurrentSession("logout");
  return NextResponse.json({ ok: true });
}
