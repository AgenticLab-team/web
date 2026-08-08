import { NextResponse } from "next/server";

import { completeRegistration } from "@/lib/auth/passkey";
import { getCurrentUser } from "@/lib/auth/session";
import { audit, auditContextFrom } from "@/lib/audit";
import { clientIp } from "@/lib/request";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body?.response) return NextResponse.json({ error: "请求格式不对" }, { status: 400 });

  const result = await completeRegistration(user.id, body.response, {
    name: typeof body.name === "string" ? body.name : undefined,
    ip: clientIp(request),
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  audit(auditContextFrom(request, user.id), {
    action: "credential.passkey.create",
    targetType: "user",
    targetId: user.id,
    after: { credentialId: result.credentialId, name: body.name },
  });

  return NextResponse.json({ ok: true });
}
