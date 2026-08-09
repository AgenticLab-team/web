import { createHash } from "node:crypto";

import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { LoginNameSetup } from "@/components/auth/LoginNameSetup";
import { PasswordSetup } from "@/components/auth/PasswordSetup";
import { GitHubPanel } from "@/components/github/GitHubPanel";
import { PasskeySetup } from "@/components/passkey/PasskeySetup";
import { SessionList } from "@/components/passkey/SessionList";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, Callout, Card, Empty, Group, Row, Section } from "@/components/ui/primitives";
import { connectionOf } from "@/lib/github/link";
import { LINK_FAILURE_MESSAGE, type LinkFailure } from "@/lib/github/oauth-rules";
import { cachedRepos } from "@/lib/github/repos";
import { githubEnabled } from "@/lib/github/secret";
import { listLoginHistory, listSessions, recentAutoRevoked } from "@/lib/auth/devices";
import { getSettingInt } from "@/lib/settings/store";
import { isPrivileged, selfLoginStatus } from "@/lib/auth/passkey-policy";
import { hasPassword } from "@/lib/auth/password-login";
import { listPasskeys } from "@/lib/auth/passkey";
import { getCurrentUser, SESSION_COOKIE } from "@/lib/auth/session";
import { effectivePermissions } from "@/lib/rbac/can";
import { getSettingBool } from "@/lib/settings/store";

export const metadata: Metadata = { title: "登录与安全" };
export const dynamic = "force-dynamic";

const METHOD_LABEL: Record<string, string> = {
  passkey: "Passkey",
  bind_code: "微信验证码",
  password: "密码",
};

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ github?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  /*
   * GitHub 绑定的结果通过查询参数回来（OAuth 回调只能重定向，
   * 没有别的办法把一句话带回站内）。**结果码是一个封闭集合** ——
   * 认不出来的一律当没有，而不是把参数原样显示出来：
   * 那等于给了一个「让本站显示任意文字」的链接。
   */
  const { github: githubResult } = await searchParams;
  const githubError =
    githubResult && githubResult !== "ok" && githubResult in LINK_FAILURE_MESSAGE
      ? LINK_FAILURE_MESSAGE[githubResult as LinkFailure]
      : null;

  // 没配置 OAuth 时整块不出现 —— 见 lib/github/secret.ts
  const githubOn = githubEnabled();
  const githubConn = githubOn ? connectionOf(user.id) : null;
  const githubCache = githubConn ? cachedRepos(user.id) : null;

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const currentHash = token ? createHash("sha256").update(token).digest("hex") : undefined;

  const passkeys = listPasskeys(user.id);
  const passwordSet = hasPassword(user.id);
  const optedOut = user.passwordOptOutAt !== null;
  const sessionList = listSessions(user.id, currentHash);
  // 设备被自动下线过就要说出来 —— 凭空消失的设备只会让人怀疑被盗号
  const autoRevoked = recentAutoRevoked(user.id);
  const sessionCap = getSettingInt("auth.session.max_per_user", 10);
  const history = listLoginHistory(user.id, 15);

  /*
   * 「我现在能怎么登录」放在页面最上面，用的是和登录时同一套判定
   * （selfLoginStatus 内部复用 lockoutRisk / passwordLoginVerdict）——
   * 这一页存在的意义就是回答这个问题，Passkey 和密码只是手段的清单。
   */
  const status = selfLoginStatus({
    privileged: isPrivileged(effectivePermissions(user).keys()),
    hasPasskey: passkeys.length > 0,
    hasPassword: passwordSet,
    enforced: getSettingBool("auth.require_passkey_for_admin", true),
  });

  return (
    <>
      <BackLink href="/me">我的</BackLink>

      <PageHeader title="登录与安全" />

      {githubError && (
        <Callout tone="warning" title="GitHub 没有绑上">
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">{githubError}</p>
        </Callout>
      )}

      <Card className="mb-5">
        <p className="t-subhead">你现在的登录方式：{status.paths.join("、")}</p>
        {status.danger && (
          <p className="t-caption mt-1.5 leading-relaxed" style={{ color: "var(--danger)" }}>
            {status.danger}
          </p>
        )}
        {status.caution && (
          <p className="t-caption mt-1.5 leading-relaxed" style={{ color: "var(--warning)" }}>
            {status.caution}
          </p>
        )}
      </Card>

      {/*
        * 登录名排在密码前面。
        *
        * 「设了密码但登录名是 wxid_examplemember01」是一个
        * 用不上的密码 —— 顺序应该是先有个记得住的名字，再谈密码。
        */}
      <Section title="登录名">
        <LoginNameSetup username={user.username} phone={user.phone} wxId={user.wxId} />
      </Section>

      <Section title="Passkey">
        <PasskeySetup items={passkeys} />
      </Section>

      <Section title="密码">
        <PasswordSetup
          hasPassword={passwordSet}
          passkeyCount={passkeys.length}
          optedOut={optedOut}
        />
      </Section>

      {githubOn && (
        <Section title="GitHub">
          <GitHubPanel
            connected={Boolean(githubConn)}
            login={githubConn?.login ?? null}
            htmlUrl={githubConn?.htmlUrl ?? null}
            repoCount={githubCache?.repos.length ?? 0}
            showOnProfile={githubConn?.showOnProfile ?? false}
            promptEnabled={githubConn?.promptEnabled ?? true}
            fetchedAt={githubCache?.fetchedAt ?? 0}
            lastError={githubCache?.error ?? null}
          />
          <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
            绑定 GitHub <strong>不是一种登录方式</strong> —— 这个站的账号只跟着微信群成员身份走，
            解绑之后你的登录方式一点都不会变。
          </p>
        </Section>
      )}

      <Section title={`登录的设备（${sessionList.length}）`}>
        <SessionList sessions={sessionList} autoRevoked={autoRevoked} cap={sessionCap} />
      </Section>

      <Section title="最近登录记录">
        {history.length === 0 ? (
          <Empty title="还没有登录记录" />
        ) : (
        <Group>
          {history.map((entry) => (
            <Row key={entry.id}>
              <span
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: entry.success ? "var(--success)" : "var(--danger)" }}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="t-subhead truncate leading-tight">
                  {METHOD_LABEL[entry.method] ?? entry.method}
                  {!entry.success && (
                    <span className="text-[var(--danger)]"> · {entry.failureReason ?? "失败"}</span>
                  )}
                </p>
                <p className="tabular t-caption text-[var(--ink-tertiary)]">
                  {new Date(entry.createdAt).toLocaleString("zh-CN", { hour12: false })}
                  {entry.ip && ` · ${entry.ip}`} · {entry.device}
                </p>
              </div>
            </Row>
          ))}
        </Group>
        )}
        <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
          失败的尝试也会记下来。看到不是你本人的登录，
          先下线全部设备，再重新设置 Passkey。
        </p>
      </Section>
    </>
  );
}
