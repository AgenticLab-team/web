import "server-only";

import { NextResponse } from "next/server";

import { eq } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

import { tokenFromHeader, type ScopeKey } from "./rules";
import { verifyToken } from "./store";

/**
 * 开放 API 的鉴权入口。
 *
 * ═════════════════════════════════════════
 * 它和网页的登录会话是**两套东西**
 * ═════════════════════════════════════════
 *
 * 网页走 cookie 会话：有设备、有 IP、能一键下线、会过期。
 * API 走令牌：一串字符，抄到哪里都能用。
 *
 * **绝不让令牌走进网页那条路，也绝不让 cookie 走进 API 这条路**：
 *   · 令牌能开网页的话，一次 CSRF 就等于一次登录
 *   · cookie 能开 API 的话，任何一个第三方页面都能用浏览器
 *     替用户调这些接口 —— 而这里有「往群里发消息」
 */

export interface ApiCaller {
  user: CurrentUser;
  tokenId: string;
  scopes: ScopeKey[];
}

export type ApiAuthResult =
  | { ok: true; caller: ApiCaller }
  | { ok: false; response: NextResponse };

/** 统一的错误体。字段名固定，调用方好判 */
export function apiError(status: number, code: string, message: string, extra?: HeadersInit) {
  return NextResponse.json({ error: { code, message } }, { status, headers: extra });
}

/**
 * 认出调用方，并检查它有没有这几个 scope。
 *
 * ─────────────────────────────────────────
 * 「没有这个 scope」和「令牌无效」分开报
 * ─────────────────────────────────────────
 *
 * 前者是 403（钥匙对，权限不够），后者是 401（钥匙不对）。
 * 混成一个的话，人拿着一把好令牌调一个没授权的接口，
 * 会以为令牌坏了，然后去重新生成一把 —— 而新的一把同样没有那个 scope。
 */
export async function authenticate(
  request: Request,
  required: readonly ScopeKey[],
): Promise<ApiAuthResult> {
  const raw = tokenFromHeader(request.headers.get("authorization"));
  const identity = raw ? verifyToken(raw) : null;

  if (!identity) {
    return {
      ok: false,
      response: apiError(401, "unauthorized", "缺少或无效的令牌。用 `Authorization: Bearer al_…`", {
        // 照规范给一个 challenge，客户端库会认
        "WWW-Authenticate": 'Bearer realm="agenticlab"',
      }),
    };
  }

  const missing = required.filter((s) => !identity.scopes.includes(s));
  if (missing.length > 0) {
    return {
      ok: false,
      response: apiError(
        403,
        "insufficient_scope",
        `这把令牌缺少权限：${missing.join("、")}。到「我的 → 开放 API」重新建一把`,
      ),
    };
  }

  /*
   * 账号本身也要再看一眼。
   *
   * 令牌是长期有效的，而账号可能在这期间被封、被注销 ——
   * 只验令牌的话，一个被封的人手里那把还能继续用，
   * 而封禁在他看来完全没有发生。
   */
  const user = db.select().from(users).where(eq(users.id, identity.userId)).get();
  if (!user || user.status !== "active") {
    return {
      ok: false,
      response: apiError(401, "unauthorized", "这个账号已经不可用了"),
    };
  }

  return { ok: true, caller: { user, tokenId: identity.tokenId, scopes: identity.scopes } };
}
