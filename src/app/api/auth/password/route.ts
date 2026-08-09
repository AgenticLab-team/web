import { NextResponse } from "next/server";

import { auditContextFrom } from "@/lib/audit";
import { IDENTIFIER_LABEL } from "@/lib/auth/login-name";
import { loginWithPassword } from "@/lib/auth/password-login";
import { tooManyLoginAttempts } from "@/lib/auth/ratelimit";
import { createSession, setSessionCookie } from "@/lib/auth/session";

/**
 * 密码登录。
 *
 * 兜底通道：Passkey 换设备就用不了，而群里的验证码依赖群猫娘没被风控 ——
 * 两条路同时不通的时候，这是唯一还能进来的方式。
 *
 * 它**不能创建账号，也不能激活账号**。这个站的入口只有微信群里那条
 * 验证码，密码只是给已经进过门的人多一把钥匙。
 */
export async function POST(request: Request) {
  const ctx = auditContextFrom(request, null);

  // IP 限流先过一道 —— 与绑定码共用同一套阈值
  const limited = tooManyLoginAttempts(ctx.actorIp);
  if (limited) {
    return NextResponse.json(
      { error: limited.message },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
    );
  }

  const body = await request.json().catch(() => null);
  /*
   * 老字段名 wxId 一起收着。
   *
   * 有人可能把登录页停在标签里好几天，那个页面发出来的还是 wxId ——
   * 改名当天让这些人收到「请填写…」是完全没必要的一次伤害。
   */
  const identifier =
    typeof body?.identifier === "string"
      ? body.identifier
      : typeof body?.wxId === "string"
        ? body.wxId
        : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!identifier || !password) {
    return NextResponse.json({ error: `请填写「${IDENTIFIER_LABEL}」和密码` }, { status: 400 });
  }

  const result = loginWithPassword({
    identifier,
    password,
    ip: ctx.actorIp,
    userAgent: ctx.actorUa,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      {
        status: result.retryAfterSeconds ? 429 : 401,
        headers: result.retryAfterSeconds
          ? { "Retry-After": String(result.retryAfterSeconds) }
          : undefined,
      },
    );
  }

  const token = createSession(result.userId!, { ip: ctx.actorIp, userAgent: ctx.actorUa });
  await setSessionCookie(token);
  return NextResponse.json({ ok: true });
}
