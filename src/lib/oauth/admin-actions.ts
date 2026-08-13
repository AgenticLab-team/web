"use server";

import { revalidatePath } from "next/cache";

import { requireWritableAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";

import { validateRedirectUri } from "./rules";
import { createApp, revokeApp } from "./store";

/**
 * 建 / 停用 OAuth 应用。**只有管理员**。
 *
 * ═════════════════════════════════════════
 * 不开放自助注册，这是防钓鱼
 * ═════════════════════════════════════════
 *
 * 一个开放自助注册的 OAuth 提供方，等于给钓鱼者发了一个官方授权页：
 * 在一千六百人的群里发「授权登录领积分」，那个授权页长得和真的一样 ——
 * **因为它就是真的**。OAuth 的钓鱼不靠伪造页面，靠伪造应用。
 *
 * 管理员建，意味着这份名单是被人看过的。
 */

export type AppResult =
  | { ok: true; note: string; clientId: string; clientSecret?: string }
  | { ok: false; error: string };

export async function createOAuthApp(input: {
  name: string;
  description: string;
  homepage: string;
  redirectUri: string;
  wantSecret: boolean;
  allowSend: boolean;
}): Promise<AppResult> {
  const admin = await requireWritableAdmin("system.settings");

  if (!input.name.trim()) return { ok: false, error: "得给它起个名字 —— 授权页上要显示" };

  const check = validateRedirectUri(input.redirectUri.trim());
  if (!check.ok) return { ok: false, error: `回调地址：${check.error}` };

  const { app, clientSecret } = createApp({
    name: input.name.trim(),
    description: input.description.trim() || null,
    homepage: input.homepage.trim() || null,
    redirectUri: input.redirectUri.trim(),
    ownerAdminId: admin.user.id,
    allowSend: input.allowSend,
    wantSecret: input.wantSecret,
  });

  audit(
    { actorId: admin.user.id },
    {
      action: "oauth.app.create",
      targetType: "oauth_app",
      targetId: app.id,
      targetLabel: app.name,
      after: { redirectUri: app.redirectUri, allowSend: app.allowSend, confidential: app.hasSecret },
      reason: "建 OAuth 应用",
    },
  );

  revalidatePath("/admin/oauth");
  return {
    ok: true,
    clientId: app.clientId,
    clientSecret,
    note: clientSecret
      ? "**client_secret 只显示这一次**，关掉就再也看不到了。现在就存到应用那边去"
      : "公开客户端没有 secret —— 它藏不住，安全性全靠 PKCE（我们强制要求）",
  };
}

export async function revokeOAuthApp(id: string, reason: string): Promise<AppResult> {
  const admin = await requireWritableAdmin("system.settings");
  if (!reason.trim()) return { ok: false, error: "写一句为什么停用它" };

  if (!revokeApp(id, `管理员停用应用：${reason}`)) {
    return { ok: false, error: "没有这个应用，或者它已经停用了" };
  }

  audit(
    { actorId: admin.user.id },
    { action: "oauth.app.revoke", targetType: "oauth_app", targetId: id, reason },
  );
  revalidatePath("/admin/oauth");
  return { ok: true, clientId: "", note: "停用了。它签出的令牌**立刻**全部失效" };
}
