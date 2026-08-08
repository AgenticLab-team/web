import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PasskeySetup } from "@/components/passkey/PasskeySetup";
import { listPasskeys } from "@/lib/auth/passkey";
import { getCurrentUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "欢迎" };
export const dynamic = "force-dynamic";

/**
 * 绑定成功后的第一屏。
 *
 * 这是引导设置 Passkey 的最佳时机 —— 此刻用户刚经历完
 * 「切到微信、加好友、填验证码、切回来」，对「下次一步进入」的价值感受最强。
 * 放到设置页里去，绝大多数人永远不会点开。
 */
export default async function OnboardingPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const passkeys = listPasskeys(user.id);
  const name = user.siteNickname ?? user.wxNickname ?? "你";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[26rem] flex-col justify-center px-6 py-12">
      <header className="mb-8 space-y-2">
        <p className="t-subhead text-[var(--accent)]">绑定成功</p>
        <h1 className="t-large-title">欢迎，{name}</h1>
        <p className="t-body leading-relaxed text-[var(--ink-secondary)]">
          最后一步：设置 Passkey，下次用指纹或面容一步进入，
          不必再回微信取验证码。
        </p>
      </header>

      <PasskeySetup items={passkeys} />

      <Link
        href="/"
        className="t-subhead mt-8 text-center text-[var(--ink-tertiary)] transition active:opacity-60"
      >
        {passkeys.length ? "进入社区" : "以后再说"}
      </Link>
    </main>
  );
}
