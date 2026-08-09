import { createHash } from "node:crypto";

import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { PasswordSetup } from "@/components/auth/PasswordSetup";
import { PasskeySetup } from "@/components/passkey/PasskeySetup";
import { SessionList } from "@/components/passkey/SessionList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Group, Row, Section } from "@/components/ui/primitives";
import { listLoginHistory, listSessions } from "@/lib/auth/devices";
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

export default async function SecurityPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const currentHash = token ? createHash("sha256").update(token).digest("hex") : undefined;

  const passkeys = listPasskeys(user.id);
  const passwordSet = hasPassword(user.id);
  const optedOut = user.passwordOptOutAt !== null;
  const sessionList = listSessions(user.id, currentHash);
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
      <Link
        href="/me"
        className="t-subhead -ml-1 mt-6 inline-flex items-center gap-0.5 text-[var(--accent)] transition active:opacity-60"
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={2.2} aria-hidden />
        我的
      </Link>

      <PageHeader title="登录与安全" />

      <div className="mb-5 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline">
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
      </div>

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

      <Section title={`登录的设备（${sessionList.length}）`}>
        <SessionList sessions={sessionList} />
      </Section>

      <Section title="最近登录记录">
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
          {history.length === 0 && (
            <Row>
              <span className="t-subhead text-[var(--ink-secondary)]">还没有记录</span>
            </Row>
          )}
        </Group>
        <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
          失败的尝试也会记下来。看到不是你本人的登录，
          先下线全部设备，再重新设置 Passkey。
        </p>
      </Section>
    </>
  );
}
