import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

import { audit, auditContextFrom } from "@/lib/audit";
import { getCurrentUser, revokeAllSessions } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const body = await request.json().catch(() => null);

  if (body?.all) {
    const result = revokeAllSessions(user.id, "credential_change", user.id);
    audit(auditContextFrom(request, user.id), {
      action: "user.session.revoke",
      targetType: "user",
      targetId: user.id,
      after: { revoked: result.changes, scope: "all" },
      reason: "用户下线全部设备",
    });
    return NextResponse.json({ ok: true, revoked: result.changes });
  }

  if (!body?.id) return NextResponse.json({ error: "缺少会话 id" }, { status: 400 });

  // 只能下线自己的会话；别人的 id 一律当作不存在，不泄露其存在性
  const result = db
    .update(sessions)
    .set({ revokedAt: Date.now(), revokedBy: user.id, revokeReason: "logout" })
    .where(
      and(eq(sessions.id, body.id), eq(sessions.userId, user.id), isNull(sessions.revokedAt)),
    )
    .run();

  if (result.changes === 0) return NextResponse.json({ error: "找不到这个会话" }, { status: 404 });

  audit(auditContextFrom(request, user.id), {
    action: "user.session.revoke",
    targetType: "session",
    targetId: body.id,
    reason: "用户下线单个设备",
  });

  return NextResponse.json({ ok: true });
}
