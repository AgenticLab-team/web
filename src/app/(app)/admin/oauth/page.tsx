import type { Metadata } from "next";

import { OAuthAppManager } from "@/components/oauth/OAuthAppManager";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, PageNote, Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import { listApps } from "@/lib/oauth/store";

export const metadata: Metadata = { title: "OAuth 应用" };
export const dynamic = "force-dynamic";

/**
 * 「管理 → OAuth 应用」。
 *
 * 应用只有管理员能建 —— 理由见 lib/oauth/admin-actions.ts 顶上那段：
 * 自助注册的 OAuth 提供方等于给钓鱼者发了一个官方授权页。
 */
export default async function AdminOAuthPage() {
  await requireAdmin("system.settings");

  return (
    <>
      <BackLink href="/admin">管理</BackLink>
      <PageHeader title="OAuth 应用" subtitle="谁能拿站里的账号去登录别的地方" />

      <Section title="应用">
        <OAuthAppManager apps={listApps()} />
      </Section>

      <PageNote>
        授权页上会显示<strong>是谁批准的这个应用</strong>和<strong>令牌会发到哪个域名</strong> ——
        后者是唯一决定令牌落到谁手里的东西，而用户从来不看地址栏。
        <br />
        <code>groups:send</code> 默认申请不到：逐群发送授权是发给
        <strong>一个具体的人</strong>的，一旦应用能拿到，代发日志里仍然写着那个人的名字，
        而真正按下发送的是一段没人 review 过的代码。
      </PageNote>
    </>
  );
}
