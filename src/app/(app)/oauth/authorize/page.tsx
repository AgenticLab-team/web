import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ConsentForm } from "@/components/oauth/ConsentForm";
import { PageHeader } from "@/components/shell/PageHeader";
import { Callout, PageNote } from "@/components/ui/primitives";
import { SCOPES } from "@/lib/api-tokens/rules";
import { getRealUser } from "@/lib/auth/session";
import { resolveDisplayName } from "@/lib/users/display-name";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { callbackWith, coversScopes, parseScopes, redirectMatches } from "@/lib/oauth/rules";
import { appByClientId, grantOf } from "@/lib/oauth/store";

export const metadata: Metadata = { title: "授权", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * 同意页。
 *
 * ═════════════════════════════════════════
 * 这一页是唯一挡在钓鱼和用户之间的东西
 * ═════════════════════════════════════════
 *
 * 所以它显示什么是**安全设计**，不是文案：
 *
 *   · **令牌会送到哪个域名** —— 唯一决定令牌落到谁手里的东西，
 *     而用户从来不看地址栏
 *   · **谁批的这个应用** —— 「站里认可」这件事只有站长背书才有意义
 *   · **逐条列出权限的人话** —— 危险的单独标出来
 *
 * ═════════════════════════════════════════
 * 它绝不建账号、绝不发会话
 * ═════════════════════════════════════════
 *
 * 用 `getRealUser()`：拿不到就跳登录页。这个站的门是微信群 ——
 * 「只有群成员能登录」如果在这里被绕过去，等于把整个站对全世界开放，
 * 而且**没有任何外部症状**（站长自己点一下是能进的）。
 *
 * 用 getRealUser 而不是 getCurrentUser：后者在预览态下返回被预览的人，
 * 于是管理员预览别人时点一下同意，授权会落到那个人头上。
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };

  const app = appByClientId(one("client_id") ?? "");
  /*
   * 应用不存在 / 回调对不上时**不跳转，就地报错**。
   *
   * 这两种情况下我们没有一个可信的地方可以跳 —— 跳去一个
   * 没注册过的地址，正好是攻击者想要的（他能借这个站做一次跳板）。
   */
  if (!app) {
    return <Broken title="这个应用不存在" hint="client_id 不对，或者它已经被站长停用了" />;
  }
  const redirectUri = one("redirect_uri");
  if (!redirectMatches(app.redirectUri, redirectUri ?? null)) {
    return (
      <Broken
        title="回调地址和注册的不一致"
        hint="出于安全，回调地址必须和注册时一模一样。请联系这个应用的开发者"
      />
    );
  }

  const state = one("state");
  const fail = (code: string) => redirect(callbackWith(app.redirectUri, { error: code, state }));

  if (one("response_type") !== "code") fail("unsupported_response_type");

  /*
   * PKCE **强制**，而且只认 S256。
   * 不给「要不要开」这个选项 —— 那个选项总会被关掉。
   */
  const challenge = one("code_challenge");
  if (!challenge || one("code_challenge_method") !== "S256") fail("invalid_request");

  const parsed = parseScopes(one("scope") ?? null, app);
  if (!parsed.ok) fail("invalid_scope");
  const scopes = parsed.ok ? parsed.scopes : [];

  const user = await getRealUser();
  if (!user) {
    // 跳登录，**不建号、不发会话**。登录完回到这一页，参数原样带回来
    const back = new URL("/oauth/authorize", "https://x.invalid");
    for (const [k, v] of Object.entries(sp)) {
      if (typeof v === "string") back.searchParams.set(k, v);
    }
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${back.searchParams}`)}`);
  }

  const owner = db.select().from(users).where(eq(users.id, app.ownerAdminId)).get();
  const ownerName = owner
    ? resolveDisplayName([owner.siteNickname, owner.wxNickname], { wxId: owner.wxId, fallback: "站长" })
    : "站长";

  /*
   * 上次已经同意过、而且**这次要的没超出上次**的话，直接放行。
   *
   * 「没超出」这一条不能省：靠上次的同意悄悄扩权，正是同意页
   * 唯一要防的事 —— 他同意的是他当时看见的那几项。
   */
  const existing = grantOf(app.id, user!.id);
  const alreadyOk = existing ? coversScopes(existing.scopes as string[], scopes) : false;

  const host = new URL(app.redirectUri).host;

  return (
    <>
      <PageHeader title="授权" subtitle={`「${app.name}」想以你的身份访问 Agentic Lab`} />

      <Callout tone="warning" title={`授权之后，令牌会发到 ${host}`}>
        <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
          这不是在登录 Agentic Lab —— 是<strong>把你的身份借给这个应用</strong>。
          它拿到的令牌，在有效期内可以代替你做下面这些事。
        </p>
      </Callout>

      <ConsentForm
        appName={app.name}
        appDescription={app.description}
        appHomepage={app.homepage}
        ownerName={ownerName}
        redirectHost={host}
        scopes={scopes.map((key) => {
          const spec = SCOPES.find((s) => s.key === key)!;
          return { key, label: spec.label, detail: spec.detail, danger: spec.danger > 0 };
        })}
        alreadyOk={alreadyOk}
        params={{
          client_id: app.clientId,
          redirect_uri: app.redirectUri,
          scope: scopes.join(" "),
          state: state ?? "",
          code_challenge: challenge ?? "",
        }}
      />

      <PageNote>
        随时可以在「我的 → 开放 API」里断开这个应用 —— 断开是立刻生效的，
        它手上的令牌会当场失效。
      </PageNote>
    </>
  );
}

/** 没有可信的跳转目标时就地报错 —— 绝不跳去一个没注册过的地址 */
function Broken({ title, hint }: { title: string; hint: string }) {
  return (
    <>
      <PageHeader title="授权" />
      <Callout tone="danger" title={title}>
        <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">{hint}</p>
      </Callout>
    </>
  );
}
