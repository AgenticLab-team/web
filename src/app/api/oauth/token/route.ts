import { NextResponse } from "next/server";

import {
  appByClientId,
  consumeCode,
  issueTokens,
  rotateRefresh,
  upsertGrant,
} from "@/lib/oauth/store";
import { hashSecret, redirectMatches, verifyPkce } from "@/lib/oauth/rules";
import { db } from "@/lib/db";
import { oauthApps } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * 拿授权码（或 refresh token）换访问令牌。
 *
 * ═════════════════════════════════════════
 * 这一条路上没有会话，也不需要有
 * ═════════════════════════════════════════
 *
 * 调它的是**应用的后端**，不是浏览器。它凭的是授权码 + PKCE verifier
 * （+ 机密客户端的 client_secret），而不是用户的 cookie。
 *
 * 所以这里**不读 cookie、不发 cookie** —— 一个会读 cookie 的
 * token 端点等于给自己开了一条 CSRF 的路。
 */

/** OAuth 的错误体照规范来（`error` / `error_description`），客户端库认它 */
function oauthError(status: number, code: string, description: string) {
  return NextResponse.json(
    { error: code, error_description: description },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  let form: URLSearchParams;
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      form = new URLSearchParams(Object.entries((await request.json()) as Record<string, string>));
    } else {
      form = new URLSearchParams(await request.text());
    }
  } catch {
    return oauthError(400, "invalid_request", "请求体解析不了");
  }

  const clientId = form.get("client_id") ?? "";
  const app = appByClientId(clientId);
  if (!app) return oauthError(401, "invalid_client", "client_id 不对，或者这个应用已经被停用");

  /*
   * 机密客户端要验密钥。
   *
   * 公开客户端（`hasSecret` 为假）不验 —— 它藏不住密钥，
   * 验一个藏不住的东西只是制造「它是安全的」的错觉。
   * 那种客户端的安全性全靠 PKCE，而 PKCE 是强制的。
   */
  if (app.hasSecret) {
    const given = form.get("client_secret");
    const row = db.select().from(oauthApps).where(eq(oauthApps.id, app.id)).get();
    if (!given || !row?.clientSecretHash || hashSecret(given) !== row.clientSecretHash) {
      return oauthError(401, "invalid_client", "client_secret 不对");
    }
  }

  const grantType = form.get("grant_type");

  if (grantType === "refresh_token") {
    const rotated = rotateRefresh(form.get("refresh_token") ?? "");
    if (!rotated.ok) {
      return oauthError(400, "invalid_grant", rotated.error);
    }
    if (rotated.appId !== app.id) {
      // 拿 A 应用的 refresh 去 B 应用换令牌
      return oauthError(400, "invalid_grant", "这个 refresh token 不属于这个应用");
    }
    const issued = issueTokens({
      appId: app.id,
      appName: app.name,
      grantId: rotated.grantId,
      userId: rotated.userId,
      scopes: rotated.scopes,
    });
    return json(issued);
  }

  if (grantType !== "authorization_code") {
    return oauthError(400, "unsupported_grant_type", "只支持 authorization_code 和 refresh_token");
  }

  const row = consumeCode(form.get("code") ?? "");
  // 授权码取出来就删了 —— 无论下面哪一步失败，它都不会有第二次机会
  if (!row) return oauthError(400, "invalid_grant", "授权码无效或已过期");

  if (row.appId !== app.id) {
    return oauthError(400, "invalid_grant", "这个授权码不属于这个应用");
  }
  /*
   * `redirect_uri` 要和当初发码时那次**逐字相同**。
   * 规范要求这一条，理由是：不比的话，攻击者可以用自己的 redirect_uri
   * 去换一个在别处发出的码。
   */
  if (!redirectMatches(row.redirectUri, form.get("redirect_uri"))) {
    return oauthError(400, "invalid_grant", "redirect_uri 和申请授权时的不一致");
  }
  if (!verifyPkce(row.codeChallenge, form.get("code_verifier"))) {
    return oauthError(400, "invalid_grant", "code_verifier 不对");
  }

  const scopes = (row.scopes as string[]) as never;
  const grantId = upsertGrant(app.id, row.userId, scopes);
  return json(issueTokens({ appId: app.id, appName: app.name, grantId, userId: row.userId, scopes }));
}

function json(issued: { accessToken: string; refreshToken: string; expiresIn: number; scopes: string[] }) {
  return NextResponse.json(
    {
      access_token: issued.accessToken,
      token_type: "Bearer",
      expires_in: issued.expiresIn,
      refresh_token: issued.refreshToken,
      scope: issued.scopes.join(" "),
    },
    // 令牌不许被任何一层缓存住
    { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
}
