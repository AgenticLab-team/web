"use client";

import { AlertTriangle, Check } from "lucide-react";
import { useState, useTransition } from "react";

import { buttonClass } from "@/components/ui/primitives";
import { approveAuthorization } from "@/lib/oauth/actions";

/**
 * 同意页上那个表单。
 *
 * ─────────────────────────────────────────
 * 「同意」和「拒绝」等大等重
 * ─────────────────────────────────────────
 *
 * 不做视觉诱导。把同意染成实心主色、拒绝缩成一行小灰字，
 * 是这类页面上最常见的做法，也是最不该做的 —— 这一页的价值
 * 全在于那个选择是**真的**。
 *
 * 用 `neutral` 而不是 `primary`：这一页没有「主要行动」，
 * 两个选项在我们看来一样好。
 */

interface ScopeView {
  key: string;
  label: string;
  detail: string;
  danger: boolean;
}

export function ConsentForm({
  appName,
  appDescription,
  appHomepage,
  ownerName,
  redirectHost,
  scopes,
  alreadyOk,
  params,
}: {
  appName: string;
  appDescription: string | null;
  appHomepage: string | null;
  ownerName: string;
  redirectHost: string;
  scopes: ScopeView[];
  /** 上次已经同意过同样（或更多）的权限 */
  alreadyOk: boolean;
  /*
   * 参数原样带回去。**服务端会全部重新校验一遍** ——
   * 这里传的东西经过了浏览器，谁都可以改。
   */
  params: {
    client_id: string;
    redirect_uri: string;
    scope: string;
    state: string;
    code_challenge: string;
  };
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const go = (approve: boolean) =>
    start(async () => {
      setError(null);
      const r = await approveAuthorization({ ...params, approve: approve ? "1" : "0" });
      if (r.ok) window.location.href = r.redirectTo;
      else setError(r.error);
    });

  return (
    <div className="inset-group px-4 py-4">
      <p className="t-headline font-medium">{appName}</p>
      {appDescription && (
        <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-secondary)]">
          {appDescription}
        </p>
      )}

      <dl className="mt-3 space-y-1.5">
        {/*
          * 「谁批的」和「令牌去哪」并列摆在权限上面。
          * 前者是这个应用值不值得信的唯一依据（站里的应用只有站长能建）；
          * 后者是唯一决定令牌落到谁手里的东西。
          */}
        <Row label="由谁批准" value={ownerName} />
        <Row label="令牌发往" value={redirectHost} mono />
        {appHomepage && <Row label="应用主页" value={appHomepage} mono />}
      </dl>

      <p className="t-caption2 mt-4 text-[var(--ink-quaternary)]">它将能够</p>
      <ul className="mt-1 space-y-1.5">
        {scopes.map((s) => (
          <li key={s.key} className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0" style={{ color: s.danger ? "var(--warning)" : "var(--accent)" }}>
              {s.danger ? (
                <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
              ) : (
                <Check className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="t-subhead font-medium">{s.label}</span>
              <span className="t-caption2 block leading-relaxed text-[var(--ink-tertiary)]">
                {s.detail}
              </span>
            </span>
          </li>
        ))}
      </ul>

      {alreadyOk && (
        <p className="t-caption2 mt-3 text-[var(--ink-tertiary)]">
          你之前已经同意过这些 —— 再点一次「同意」就会换一把新令牌给它。
        </p>
      )}

      {error && (
        <p className="t-caption mt-3" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}

      {/* 两个按钮等大等重，不做视觉诱导 —— 见文件顶上 */}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => go(true)}
          className={buttonClass("neutral", "md", "flex-1")}
        >
          {pending ? "处理中…" : "同意"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => go(false)}
          className={buttonClass("neutral", "md", "flex-1")}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="t-caption2 w-16 shrink-0 text-[var(--ink-quaternary)]">{label}</dt>
      <dd className={`t-footnote min-w-0 flex-1 break-all ${mono ? "font-mono font-medium" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
