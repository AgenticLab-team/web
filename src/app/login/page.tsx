import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { BindFlow } from "@/components/BindFlow";
import { getCurrentUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "登录" };

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/");

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[26rem] flex-col justify-center px-6 py-12">
      <header className="mb-9 space-y-2">
        <h1 className="text-[34px] font-bold leading-tight tracking-[-0.02em]">Agentic Lab</h1>
        <p className="text-[17px] text-[var(--color-ink-secondary)]">
          用微信身份登录，之后就不再需要它。
        </p>
      </header>

      <BindFlow />

      <footer className="mt-10 text-center text-[13px] leading-relaxed text-[var(--color-ink-tertiary)]">
        登录后可以设置 Passkey，下次一键进入。
      </footer>
    </main>
  );
}
