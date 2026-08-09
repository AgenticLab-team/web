"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * 密码登录表单。
 *
 * 默认**收起来**。它是兜底通道 —— 摊开在首屏会把「用微信验证」
 * 这条主路挤到下面，而绝大多数人该走的是主路。
 *
 * 但也不能藏得太深：需要它的人恰恰是已经进不来的人，
 * 那时候多一层折叠就是多一分挫败。所以是一行可点的文字，不是菜单里的一项。
 */
export function PasswordLoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [wxId, setWxId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wxId: wxId.trim(), password }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(data.error ?? "登录失败");
        // 失败之后清掉密码框：留着上一次输错的内容，人会直接再点一次
        setPassword("");
        return;
      }
      router.replace(next);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="t-caption w-full text-center text-[var(--ink-tertiary)] underline-offset-4 transition hover:underline"
      >
        用密码登录
      </button>
    );
  }

  return (
    <form
      className="animate-rise space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        value={wxId}
        onChange={(e) => setWxId(e.target.value)}
        placeholder="微信 ID"
        autoComplete="username"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className={inputClass}
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="密码"
        autoComplete="current-password"
        className={inputClass}
      />

      <button
        type="submit"
        disabled={pending || !wxId.trim() || !password}
        className="t-subhead flex w-full items-center justify-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--fill)] px-4 py-2.5 font-medium transition active:opacity-70 disabled:opacity-40"
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.2} aria-hidden />}
        登录
      </button>

      {error && (
        <p
          className="t-caption px-1 leading-relaxed"
          style={{ color: "var(--danger)" }}
          role="alert"
        >
          {error}
        </p>
      )}

      <p className="t-caption2 px-1 leading-relaxed text-[var(--ink-quaternary)]">
        密码要先在站内设置过才能用（我的 → 登录与安全）。没设过就走上面的微信验证。
      </p>
    </form>
  );
}

const inputClass =
  "t-body w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3.5 py-2.5 outline-none transition focus:ring-2 focus:ring-[var(--accent)]";
