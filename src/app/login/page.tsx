import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { BindFlow } from "@/components/BindFlow";
import { PasswordLoginForm } from "@/components/auth/PasswordLoginForm";
import { PasskeyLoginButton } from "@/components/passkey/PasskeyLoginButton";
import { safeRedirect } from "@/lib/auth/routes";
import { getCurrentUser } from "@/lib/auth/session";
import Link from "next/link";

export const metadata: Metadata = { title: "登录" };
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await getCurrentUser();
  const { next } = await searchParams;
  const target = safeRedirect(next);
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

      {/* 兜底通道放在最下面 —— 需要它的人会去找，不需要的人不该被它挡住 */}
      <div className="mt-6">
        <PasswordLoginForm next={target} />
      </div>

      {/*
        * 给「还不是成员」的人一条路。
        *
        * 这一页所有的路都假设你已经在群里 —— 而一个不在群里的人
        * 走到这里只会反复取验证码然后发现没地方发。
        * 生产上一天 392 个码里有一批就是这么来的。
        */}
      <p className="t-caption mt-8 text-center text-[var(--ink-tertiary)]">
        还不在群里？
        <Link href="/join" className="ml-1 text-[var(--accent)]">
          申请加入
        </Link>
      </p>

      <footer className="t-caption mt-6 text-center leading-relaxed text-[var(--ink-tertiary)]">
        首次登录后可以设置 Passkey，下次一步进入。
        <br />
        建议同时设一个密码 —— Passkey 换设备就用不了，
        而验证码要靠群猫娘发得出来。
      </footer>
    </main>
  );
}
