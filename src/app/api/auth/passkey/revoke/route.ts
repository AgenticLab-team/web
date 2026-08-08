import { NextResponse } from "next/server";

import { listPasskeys, revokePasskey } from "@/lib/auth/passkey";
import { getCurrentUser } from "@/lib/auth/session";
import { audit, auditContextFrom } from "@/lib/audit";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body?.id) return NextResponse.json({ error: "缺少凭证 id" }, { status: 400 });

  const before = listPasskeys(user.id);
  const result = revokePasskey(user.id, body.id, "用户主动移除");
  if (result.changes === 0) {
    // 不区分「不存在」与「不属于你」，避免探测他人凭证 id
    return NextResponse.json({ error: "找不到这个凭证" }, { status: 404 });
  }

  audit(auditContextFrom(request, user.id), {
    action: "credential.passkey.revoke",
    targetType: "user",
    targetId: user.id,
    before: { count: before.length },
    after: { count: listPasskeys(user.id).length },
    reason: "用户主动移除",
  });

  return NextResponse.json({ ok: true });
}
