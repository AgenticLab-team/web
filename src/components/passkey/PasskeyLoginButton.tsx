"use client";

import { Fingerprint } from "lucide-react";
import { useRouter } from "next/navigation";

import { usePasskeyLogin, usePasskeySupport } from "./usePasskey";

/**
 * Passkey 登录入口。
 *
 * 放在验证码流程**之前** —— 对已经设过 Passkey 的人来说，
 * 这是一步完成的，而验证码流程要切到微信再切回来。
 * 不支持的浏览器直接不渲染，不留一个点了报错的按钮。
 */
export function PasskeyLoginButton() {
  const router = useRouter();
  const support = usePasskeySupport();
  const { busy, error, login } = usePasskeyLogin();

  if (support === "unknown" || support === "unsupported") return null;

  return (
    <div className="animate-fade space-y-2">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          const next = await login();
          if (next) router.replace(next);
        }}
        className="flex w-full items-center justify-center gap-2.5 rounded-[var(--radius-control)] bg-[var(--ink)] px-6 py-3.5 text-[var(--canvas)] transition active:scale-[0.98] disabled:opacity-50"
      >
        <Fingerprint className="h-[1.125rem] w-[1.125rem]" strokeWidth={2} aria-hidden />
        <span className="t-body font-medium">{busy ? "等待验证…" : "用 Passkey 登录"}</span>
      </button>
      {error && (
        <p className="t-footnote text-center text-[var(--danger)]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
