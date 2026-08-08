import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { BindFlow } from "@/components/BindFlow";
import { PasskeyLoginButton } from "@/components/passkey/PasskeyLoginButton";
import { getCurrentUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "登录" };
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await getCurrentUser();
  const { next } = await searchParams;
  // 只接受站内相对路径 —— 允许绝对地址就成了开放重定向，
  // 攻击者可以拿登录链接把人导到钓鱼站
  const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  if (user) redirect(target);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[26rem] flex-col justify-center px-6 py-12">
      <header className="mb-8 space-y-2">
        <h1 className="t-large-title">Agentic Lab</h1>
        <p className="t-body text-[var(--ink-secondary)]">
          用微信身份登录，之后就不再需要它。
        </p>
      </header>

      {/* Passkey 放在验证码流程之前：设过的人一步就进来了 */}
      <div className="mb-6">
        <PasskeyLoginButton />
      </div>

      <div className="mb-6 flex items-center gap-3" aria-hidden>
        <span className="h-px flex-1 bg-[var(--separator)]" />
        <span className="t-caption text-[var(--ink-tertiary)]">或用微信验证</span>
        <span className="h-px flex-1 bg-[var(--separator)]" />
      </div>

      <BindFlow next={target} />

      <footer className="t-caption mt-10 text-center leading-relaxed text-[var(--ink-tertiary)]">
        首次登录后可以设置 Passkey，下次一步进入。
      </footer>
    </main>
  );
}
