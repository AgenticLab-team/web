"use client";

import { useState, useTransition } from "react";

import { buttonClass } from "@/components/ui/primitives";
import { createOAuthApp, revokeOAuthApp } from "@/lib/oauth/admin-actions";
import type { OAuthApp } from "@/lib/oauth/store";

/**
 * 建和停用 OAuth 应用。
 *
 * ─────────────────────────────────────────
 * client_secret 只显示这一次
 * ─────────────────────────────────────────
 *
 * 库里存的是哈希，所以它真的只在创建那一刻存在过。
 * 不把这件事说死的话，人会关掉页面然后回来找 ——
 * 而那时候我们能给的只有一句「看不到了，重建一个吧」。
 */
export function OAuthAppManager({ apps }: { apps: OAuthApp[] }) {
  const [name, setName] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [description, setDescription] = useState("");
  const [homepage, setHomepage] = useState("");
  const [wantSecret, setWantSecret] = useState(true);
  const [allowSend, setAllowSend] = useState(false);
  const [fresh, setFresh] = useState<{ clientId: string; clientSecret?: string; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const field =
    "t-body mt-1 w-full min-h-11 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 outline-none";
  const label = "t-caption2 mt-3 block text-[var(--ink-quaternary)]";

  const submit = () =>
    start(async () => {
      setError(null);
      setFresh(null);
      const r = await createOAuthApp({ name, description, homepage, redirectUri, wantSecret, allowSend });
      if (r.ok) {
        setFresh({ clientId: r.clientId, clientSecret: r.clientSecret, note: r.note });
        setName("");
        setRedirectUri("");
        setDescription("");
        setHomepage("");
      } else setError(r.error);
    });

  const revoke = (app: OAuthApp) =>
    start(async () => {
      setError(null);
      const why = window.prompt(`停用「${app.name}」的理由？它签出的令牌会立刻全部失效`);
      if (!why) return;
      const r = await revokeOAuthApp(app.id, why);
      if (!r.ok) setError(r.error);
    });

  return (
    <>
      <div className="inset-group mb-3 px-3.5 py-3">
        <p className="t-subhead font-medium">建一个应用</p>

        <label className={label}>名字（授权页上显示）</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={field}
          aria-label="应用名字"
          placeholder="比如：打卡助手"
        />

        <label className={label}>回调地址（精确匹配，注册什么就只能用什么）</label>
        <input
          value={redirectUri}
          onChange={(e) => setRedirectUri(e.target.value)}
          className={`${field} font-mono`}
          aria-label="回调地址"
          placeholder="https://app.example.com/callback"
        />

        <label className={label}>一句话说明（可选，授权页上显示）</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={field}
          aria-label="一句话说明"
          placeholder="它是做什么的"
        />

        <label className={label}>应用主页（可选 —— 让人有地方查这是谁）</label>
        <input
          value={homepage}
          onChange={(e) => setHomepage(e.target.value)}
          className={`${field} font-mono`}
          aria-label="应用主页"
          placeholder="https://example.com"
        />

        <label className="mt-3 flex items-start gap-2">
          <input
            type="checkbox"
            checked={wantSecret}
            onChange={(e) => setWantSecret(e.target.checked)}
            className="mt-1 h-5 w-5 shrink-0"
          />
          <span className="t-caption leading-relaxed text-[var(--ink-secondary)]">
            机密客户端（有自己的后端）—— 发一个 client_secret。
            <br />
            纯前端 / 移动端请<strong>取消勾选</strong>：那种客户端藏不住密钥，
            发一个只是制造「它是安全的」的错觉。它的安全性靠 PKCE，而 PKCE 是强制的。
          </span>
        </label>

        <label className="mt-3 flex items-start gap-2">
          <input
            type="checkbox"
            checked={allowSend}
            onChange={(e) => setAllowSend(e.target.checked)}
            className="mt-1 h-5 w-5 shrink-0"
          />
          <span className="t-caption leading-relaxed" style={{ color: allowSend ? "var(--danger)" : "var(--ink-secondary)" }}>
            允许它申请 <code>groups:send</code>
            <br />
            ⚠️ 逐群发送授权是发给<strong>一个具体的人</strong>的。给了应用之后，
            代发日志里仍然写着那个人的名字，而真正按下发送的是一段没人 review 过的代码 ——
            <strong>那条审计记录从此不再回答它本来要回答的问题</strong>。
          </span>
        </label>

        <button
          type="button"
          disabled={pending || !name.trim() || !redirectUri.trim()}
          onClick={submit}
          className={buttonClass("primary", "md", "mt-3")}
        >
          {pending ? "处理中…" : "建"}
        </button>

        {error && (
          <p className="t-caption mt-2" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}

        {fresh && (
          <div className="mt-3 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-3">
            <p className="t-caption2 text-[var(--ink-quaternary)]">client_id</p>
            <code className="t-footnote block break-all font-medium">{fresh.clientId}</code>
            {fresh.clientSecret && (
              <>
                <p className="t-caption2 mt-2 text-[var(--ink-quaternary)]">client_secret</p>
                <code className="t-footnote block break-all font-medium">{fresh.clientSecret}</code>
              </>
            )}
            <p className="t-caption2 mt-2 leading-relaxed" style={{ color: "var(--warning)" }}>
              {fresh.note}
            </p>
          </div>
        )}
      </div>

      {apps.length === 0 ? (
        <p className="t-caption px-1 text-[var(--ink-tertiary)]">还没有任何应用。</p>
      ) : (
        <div className="space-y-1.5">
          {apps.map((a) => (
            <div key={a.id} className="inset-group flex items-start gap-2.5 px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <p className="t-subhead font-medium">
                  {a.name}
                  {a.allowSend && (
                    <span className="t-caption2 ml-1.5" style={{ color: "var(--danger)" }}>
                      可申请代发
                    </span>
                  )}
                  {!a.hasSecret && (
                    <span className="t-caption2 ml-1.5 text-[var(--ink-quaternary)]">公开客户端</span>
                  )}
                </p>
                <code className="t-caption2 block break-all text-[var(--ink-quaternary)]">
                  {a.clientId}
                </code>
                <code className="t-caption2 block break-all text-[var(--ink-tertiary)]">
                  → {a.redirectUri}
                </code>
              </div>
              <button
                type="button"
                disabled={pending}
                onClick={() => revoke(a)}
                className={buttonClass("dangerSoft", "sm")}
              >
                停用
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
