import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PasskeySetup } from "@/components/passkey/PasskeySetup";
import { ToastProvider } from "@/components/ui/Toast";
import { listPasskeys } from "@/lib/auth/passkey";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveDisplayName } from "@/lib/users/display-name";

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
  const name = resolveDisplayName([user.siteNickname, user.wxNickname], {
    wxId: user.wxId,
    fallback: "你",
  });

  return (
    // 这个页面在 (app) 布局之外，必须自带 ToastProvider ——
    // 否则 useToast 静默退化，Passkey 添加/移除的提示一个都弹不出来
    <ToastProvider>
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

      {/*
        ─────────────────────────────────────────
        绑定完成之后，下一步不该是「进入社区」
        ─────────────────────────────────────────

        「进入社区」把人扔在首页上 —— 而他此刻对这 45,000 条记录
        没有任何上下文，不知道这个群平时聊什么、谁是常驻、
        几点开口有人接。看两眼就退出去了。

        所以主出口改成补课包，「直接进去」留作次要选项：
        想跳过的人一点就走，不拦。
      */}
      <Link
        href="/welcome"
        className="t-subhead mt-8 inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--fill)] px-5 font-medium text-[var(--ink)] transition active:scale-[0.97]"
      >
        先看看群里在聊什么
      </Link>

      <Link
        href="/"
        className="tap-target t-subhead mt-3 text-center text-[var(--ink-tertiary)] transition active:opacity-60"
      >
        {passkeys.length ? "直接进入社区" : "以后再说"}
      </Link>
    </main>
    </ToastProvider>
  );
}
