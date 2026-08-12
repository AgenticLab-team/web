"use client";

import { AlertTriangle, Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";

import { ActionButton, CONTROL, Field, Panel, StatusNote } from "@/components/api/fields";
import { createTokenAction, revokeTokenAction } from "@/lib/api-tokens/actions";
import type { TokenRow } from "@/lib/api-tokens/store";

/**
 * 令牌列表 + 新建。
 *
 * ═════════════════════════════════════════
 * 明文只出现一次，所以那一刻要说清楚
 * ═════════════════════════════════════════
 *
 * 库里只有哈希，关掉这块就再也拿不回来。不说的话，人会关掉页面
 * 然后回来找 —— 而那时候我们能给的只有一句「重新建一把吧」，
 * 那是一次本来可以避免的挫败。
 *
 * 所以新建成功之后**不自动收起**：它一直摆在那儿，直到本人点「我存好了」。
 * 而且那一刻要给一个复制按钮 —— 一串 46 个字符的东西，
 * 在手机上靠长按选中是真的会选歪的。
 *
 * ═════════════════════════════════════════
 * 撤销要问一次
 * ═════════════════════════════════════════
 *
 * 原来那个垃圾桶图标是**点一下就生效**的：手机上误触一次，
 * 正在跑的脚本当场全挂，而且没有任何办法撤回（库里只有哈希，
 * 建不回同一把）。所以改成两步 —— 第二步的按钮上写着令牌的名字。
 */

interface Scope {
  key: string;
  label: string;
  detail: string;
  danger: number;
}

export function TokenManager({
  tokens,
  scopes,
}: {
  tokens: TokenRow[];
  scopes: Scope[];
}) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set(["me:read"]));
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 正在等第二下确认的那把。null = 没有 */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const create = () =>
    start(async () => {
      setError(null);
      const r = await createTokenAction(name, [...picked]);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setFresh(r.plaintext ?? null);
      setCopied(false);
      setName("");
    });

  const revoke = (id: string) =>
    start(async () => {
      setError(null);
      setConfirming(null);
      const r = await revokeTokenAction(id);
      if (!r.ok) setError(r.error);
    });

  const copy = async () => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh);
      setCopied(true);
    } catch {
      /*
       * 复制失败不当成错误提示 —— 明文就在上面那个框里，
       * 手动选中一样能拿到。弹一句红色的「复制失败」只会
       * 让人以为令牌出了问题。
       */
      setCopied(false);
    }
  };

  const live = tokens.filter((t) => t.revokedAt === null);
  const dead = tokens.filter((t) => t.revokedAt !== null);

  return (
    <div className="space-y-3">
      {/*
        * ── 刚建出来的那一把 ─────────────────────────
        *
        * 摆在最上面而不是表单底下：它是这一刻唯一要紧的东西，
        * 而表单底下那个位置在手机上通常已经滑出屏幕了。
        */}
      {fresh && (
        <div
          className="inset-group p-4"
          style={{ boxShadow: "inset 0 0 0 1.5px var(--accent)" }}
        >
          <h3 className="t-headline" style={{ color: "var(--accent)" }}>
            这是你的新令牌
          </h3>
          <p className="t-footnote mt-1 leading-relaxed text-[var(--ink-secondary)]">
            只显示这一次。现在就存到要用它的地方去。
          </p>

          <code className="t-footnote mt-3 block break-all rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-3 font-mono leading-relaxed">
            {fresh}
          </code>

          <div className="mt-3 flex flex-wrap gap-2">
            <ActionButton
              onClick={copy}
              icon={
                copied ? (
                  <Check className="h-4 w-4" strokeWidth={2.4} aria-hidden />
                ) : (
                  <Copy className="h-4 w-4" strokeWidth={2.2} aria-hidden />
                )
              }
            >
              {copied ? "已复制" : "复制"}
            </ActionButton>
            <ActionButton tone="quiet" onClick={() => setFresh(null)}>
              我存好了
            </ActionButton>
          </div>
        </div>
      )}

      {/* ── 建一把新的 ─────────────────────────────── */}

      <Panel
        id="tokens"
        title="建一把新令牌"
        hint="勾上它需要的权限就好。少给的随时能再建一把，多给的收不回来。"
      >
        <Field label="名字" hint="写它是干什么的 —— 撤销的时候你要靠这个认出它">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="比如「打卡机器人」"
            className={CONTROL}
          />
        </Field>

        <fieldset className="mt-4">
          <legend className="t-footnote font-medium text-[var(--ink-secondary)]">
            它能做什么
          </legend>
          <div className="mt-1.5 overflow-hidden rounded-[var(--radius-control)] bg-[var(--surface-sunken)]">
            {scopes.map((s) => {
              const on = picked.has(s.key);
              /*
               * 危险的那一项要标出来，而且**默认不勾**。
               * 它会往一千六百人的群里发东西，署名还是机器人。
               */
              const risky = s.danger >= 2;
              return (
                <label
                  key={s.key}
                  className="inset-row flex min-h-11 cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors hover:bg-[var(--fill)]"
                  style={
                    risky && on
                      ? { background: "color-mix(in srgb, var(--danger) 8%, transparent)" }
                      : undefined
                  }
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(s.key)}
                    className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="t-subhead flex flex-wrap items-center gap-1.5 font-medium">
                      {s.label}
                      {risky && (
                        <span
                          className="t-caption2 inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-1.5 py-0.5"
                          style={{
                            background: "color-mix(in srgb, var(--danger) 12%, transparent)",
                            color: "var(--danger)",
                          }}
                        >
                          <AlertTriangle className="h-3 w-3" strokeWidth={2.4} aria-hidden />
                          要当心
                        </span>
                      )}
                    </span>
                    <span className="t-caption mt-0.5 block leading-relaxed text-[var(--ink-tertiary)]">
                      {s.detail}
                    </span>
                    <code className="t-caption2 mt-0.5 block text-[var(--ink-quaternary)]">
                      {s.key}
                    </code>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <ActionButton
            busy={pending}
            disabled={picked.size === 0}
            onClick={create}
            icon={<Plus className="h-4 w-4" strokeWidth={2.4} aria-hidden />}
          >
            {pending ? "生成中…" : "生成令牌"}
          </ActionButton>
          {/* 一项都没勾时说清楚为什么按钮是灰的，而不是让人对着它猜 */}
          {picked.size === 0 && (
            <span className="t-caption text-[var(--ink-tertiary)]">至少勾一项权限</span>
          )}
        </div>

        {error && (
          <StatusNote
            tone="error"
            className="mt-3"
            icon={<AlertTriangle className="h-4 w-4" strokeWidth={2.2} aria-hidden />}
          >
            {error}
          </StatusNote>
        )}
      </Panel>

      {/* ── 手上有的 ───────────────────────────────── */}

      {live.length === 0 ? (
        <p className="t-footnote px-1 leading-relaxed text-[var(--ink-tertiary)]">
          你还没有令牌。建一把之后，下面的在线测试和所有接口才调得动。
        </p>
      ) : (
        <div className="inset-group">
          {live.map((t) => {
            const asking = confirming === t.id;
            return (
              <div key={t.id} className="inset-row flex items-start gap-3 p-4">
                <span
                  className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--ink-tertiary)]"
                  style={{ background: "var(--fill)" }}
                  aria-hidden
                >
                  <KeyRound className="h-4 w-4" strokeWidth={2.2} aria-hidden />
                </span>

                <div className="min-w-0 flex-1">
                  <p className="t-subhead font-medium">{t.name}</p>
                  {/*
                    * 显示前几位 —— 列表上要能回答「我撤销的是哪一把」。
                    * 只显示名字不够：人起的名字经常是「测试」「新的」「1」。
                    */}
                  <code className="t-caption2 mt-0.5 block text-[var(--ink-quaternary)]">
                    al_{t.visible}… · {t.lastUsedAt ? "用过" : "还没用过"}
                  </code>
                  {/*
                    * 权限做成一排小标签，不是一串顿号隔开的文字。
                    * 六个 scope 挤成一行时，「这把能不能发消息」
                    * 要一个字一个字读过去才答得出来。
                    */}
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {t.scopes.map((s) => (
                      <code
                        key={s}
                        className="t-caption2 rounded-[var(--radius-pill)] px-1.5 py-0.5"
                        style={
                          s === "groups:send"
                            ? {
                                background: "color-mix(in srgb, var(--danger) 12%, transparent)",
                                color: "var(--danger)",
                              }
                            : { background: "var(--fill)", color: "var(--ink-secondary)" }
                        }
                      >
                        {s}
                      </code>
                    ))}
                  </div>

                  {/* 第二步摆在卡片里面、按钮上写着名字 —— 见文件头 */}
                  {asking && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <ActionButton tone="danger" busy={pending} onClick={() => revoke(t.id)}>
                        撤销「{t.name}」
                      </ActionButton>
                      <ActionButton tone="quiet" onClick={() => setConfirming(null)}>
                        算了
                      </ActionButton>
                      <span className="t-caption w-full text-[var(--ink-tertiary)]">
                        撤销立刻生效，在用它的程序会当场 401。建不回同一把。
                      </span>
                    </div>
                  )}
                </div>

                {!asking && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => setConfirming(t.id)}
                    className="tap-target shrink-0 p-1.5 text-[var(--ink-tertiary)] transition active:opacity-60 disabled:opacity-45"
                    aria-label={`撤销令牌 ${t.name}`}
                  >
                    <Trash2 className="h-4 w-4" strokeWidth={2} aria-hidden />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/*
        * ── 撤销过的 ─────────────────────────────────
        *
        * 库里本来就留着（tokensOf 的注释：「撤销过的也列出来」），
        * 而界面之前把它们整个丢掉了 —— 于是「我上周是不是撤过一把」
        * 没有任何地方答得出来。收进折叠里：它是记录，不是待办。
        */}
      {dead.length > 0 && (
        <details className="inset-group">
          <summary className="t-footnote flex min-h-11 cursor-pointer list-none items-center justify-between px-4 py-3 text-[var(--ink-secondary)]">
            撤销过的（{dead.length}）
            <span className="t-caption text-[var(--ink-quaternary)] [details[open]_&]:hidden">展开</span>
          </summary>
          <div className="px-4 pb-3">
            {dead.map((t) => (
              <p key={t.id} className="t-caption py-1 text-[var(--ink-tertiary)]">
                <span className="line-through">{t.name}</span>
                <code className="ml-1.5 text-[var(--ink-quaternary)]">al_{t.visible}…</code>
                {t.revokedReason && ` · ${t.revokedReason}`}
              </p>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
