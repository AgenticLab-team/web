import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { buildRegistrationOptions } from "@/lib/auth/passkey";
import { clientIp } from "@/lib/request";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  // 注册 Passkey 必须先登录 —— 否则任何人都能给别人的账号加一把钥匙
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const options = await buildRegistrationOptions(user.id, clientIp(request));
  return NextResponse.json(options);
}
