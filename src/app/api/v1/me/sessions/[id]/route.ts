import { NextResponse } from "next/server";

import { and, eq, isNull } from "drizzle-orm";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { audit, auditContextFrom } from "@/lib/audit";
import { revokeAllSessions } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/**
 * 把某个设备踢下线。`id` 传 `all` 就是全部。
 *
 * ─────────────────────────────────────────
 * 别人的会话 id 一律当作**不存在**
 * ─────────────────────────────────────────
 *
 * 报「这个会话不属于你」等于确认了它存在 —— 而会话 id 出现在
 * 审计日志里，也就是说一个有日志读权限的人能靠这条接口
 * 探测别人有没有在线。
 *
 * 所以 where 里带上 `userId`，查不到就是 404，两种情况同一句话。
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticate(request, ["me:write"]);
  if (!auth.ok) return auth.response;

  const { user } = auth.caller;
  const id = decodeURIComponent((await params).id);

  if (id === "all") {
    const result = revokeAllSessions(user.id, "credential_change", user.id);
    audit(auditContextFrom(request, user.id), {
      action: "user.session.revoke",
      targetType: "user",
      targetId: user.id,
      after: { revoked: result.changes, scope: "all", via: "api" },
      reason: "用户从终端下线全部设备",
    });
    return NextResponse.json({ ok: true, revoked: result.changes });
  }

  const result = db
    .update(sessions)
    .set({ revokedAt: Date.now(), revokedBy: user.id, revokeReason: "logout" })
    .where(and(eq(sessions.id, id), eq(sessions.userId, user.id), isNull(sessions.revokedAt)))
    .run();

  if (result.changes === 0) return apiError(404, "not_found", "找不到这个会话");

  audit(auditContextFrom(request, user.id), {
    action: "user.session.revoke",
    targetType: "session",
    targetId: id,
    reason: "用户从终端下线单个设备",
  });
  return NextResponse.json({ ok: true });
}
