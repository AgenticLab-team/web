"use server";

import { getRealUser } from "@/lib/auth/session";
import { audit } from "@/lib/audit";

import { callbackWith, parseScopes, redirectMatches } from "./rules";
import { appByClientId, issueCode } from "./store";

/**
 * 用户在同意页上按下的那一下。
 *
 * ═════════════════════════════════════════
 * 这个文件是 "use server"，每个导出都能被客户端直接调
 * ═════════════════════════════════════════
 *
 * 所以它**自己取当前用户**，绝不收 userId 当参数 ——
 * 收了的话，任何人都能传一个别人的 id 进来，替别人授权。
 *
 * 而且**所有参数都重新校验一遍**：页面上校验过不算数，
 * 那次校验发生在浏览器能改的地方。
 */

export type ConsentResult = { ok: true; redirectTo: string } | { ok: false; error: string };

export async function approveAuthorization(input: {
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string;
  code_challenge: string;
  approve: string;
}): Promise<ConsentResult> {
  const user = await getRealUser();
  if (!user) return { ok: false, error: "先登录" };

  const app = appByClientId(input.client_id);
  if (!app) return { ok: false, error: "这个应用不存在或已被停用" };

  // 回调地址重新验 —— 页面上那次不算数
  if (!redirectMatches(app.redirectUri, input.redirect_uri)) {
    return { ok: false, error: "回调地址和注册的不一致" };
  }

  const state = input.state || undefined;

  if (input.approve !== "1") {
    // 拒绝也要留审计 —— 「他到底点没点过同意」是事后唯一要问的问题
    audit(
      { actorId: user.id },
      {
        action: "oauth.deny",
        targetType: "oauth_app",
        targetId: app.id,
        targetLabel: app.name,
        reason: "用户在授权页选择了拒绝",
      },
    );
    return { ok: true, redirectTo: callbackWith(app.redirectUri, { error: "access_denied", state }) };
  }

  const parsed = parseScopes(input.scope, app);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  if (!input.code_challenge) return { ok: false, error: "缺少 PKCE 参数" };

  const code = issueCode({
    appId: app.id,
    userId: user.id,
    scopes: parsed.scopes,
    codeChallenge: input.code_challenge,
    redirectUri: app.redirectUri,
  });

  audit(
    { actorId: user.id },
    {
      action: "oauth.approve",
      targetType: "oauth_app",
      targetId: app.id,
      targetLabel: app.name,
      after: { scopes: parsed.scopes },
      reason: "用户在授权页同意",
    },
  );

  return { ok: true, redirectTo: callbackWith(app.redirectUri, { code, state }) };
}
