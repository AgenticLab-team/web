"use client";

import { KeyRound, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";

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
 */

interface Scope {
  key: string;
  label: string;
  detail: string;
  danger: number;
}

interface Usage {
  minute: number;
  hour: number;
  day: number;
}

export function TokenManager({
  tokens,
  scopes,
  usage,
  limits,
}: {
  tokens: TokenRow[];
  scopes: Scope[];
  usage: Record<string, Usage>;
  limits: { perMinute: number; perHour: number; perDay: number };
}) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set(["me:read"]));
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      setName("");
    });

  const revoke = (id: string) =>
    start(async () => {
      setError(null);
      const r = await revokeTokenAction(id);
      if (!r.ok) setError(r.error);
    });

  const live = tokens.filter((t) => t.revokedAt === null);

  return (
    <section className="mb-7">
      {fresh && (
        <div className="inset-group mb-4 px-3.5 py-3">
          <p className="t-subhead font-medium text-[var(--accent)]">这是你的新令牌</p>
          <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-secondary)]">
            只显示这一次，关掉就再也看不到了 —— 现在就存到你要用它的地方去。
          </p>
          <code className="t-caption2 mt-2 block break-all rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-2.5">
            {fresh}
          </code>
          <button
            type="button"
            onClick={() => setFresh(null)}
            className="t-footnote mt-2 inline-flex min-h-11 items-center rounded-[var(--radius-pill)] px-3.5 font-medium text-[var(--accent)] transition active:opacity-60"
            style={{ background: "color-mix(in srgb, var(--accent) 12%, transparent)" }}
          >
            我存好了
          </button>
        </div>
      )}

      <div className="inset-group mb-4 px-3.5 py-3">
        <p className="t-subhead font-medium">建一把新的</p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="给它起个名字，比如「打卡机器人」"
          className="t-body mt-2 w-full rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2 outline-none"
        />

        <div className="mt-3 space-y-2">
          {scopes.map((s) => (
            <label key={s.key} className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={picked.has(s.key)}
                onChange={() => toggle(s.key)}
                className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
              />
              <span className="min-w-0 flex-1">
                <span className="t-subhead block font-medium">
                  {s.label}
                  {/*
                    * 危险的那一项要标出来，而且**默认不勾**。
                    * 它会往一千六百人的群里发东西，署名还是机器人。
                    */}
                  {s.danger >= 2 && (
                    <span className="t-caption2 ml-1.5 rounded-[var(--radius-pill)] px-1.5 py-0.5 text-[var(--danger)]"
                      style={{ background: "color-mix(in srgb, var(--danger) 12%, transparent)" }}>
                      要当心
                    </span>
                  )}
                </span>
                <span className="t-caption2 block leading-relaxed text-[var(--ink-tertiary)]">
                  {s.detail}
                </span>
              </span>
            </label>
          ))}
        </div>

        <button
          type="button"
          disabled={pending}
          onClick={create}
          className="t-footnote mt-3 inline-flex min-h-11 items-center rounded-[var(--radius-pill)] px-3.5 font-medium text-[var(--accent)] transition active:opacity-60 disabled:opacity-45"
          style={{ background: "color-mix(in srgb, var(--accent) 12%, transparent)" }}
        >
          {pending ? "处理中…" : "生成令牌"}
        </button>

        {error && (
          <p className="t-caption mt-2" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}
      </div>

      {live.length > 0 && (
        <div className="space-y-1.5">
          {live.map((t) => (
            <div key={t.id} className="inset-group flex items-start gap-2.5 px-3.5 py-3">
              <span
                className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--ink-tertiary)]"
                style={{ background: "var(--fill)" }}
                aria-hidden
              >
                <KeyRound className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="t-subhead font-medium">{t.name}</p>
                <p className="t-caption2 text-[var(--ink-quaternary)]">
                  {/*
                    * 显示前几位 —— 列表上要能回答「我撤销的是哪一把」。
                    * 只显示名字不够：人起的名字经常是「测试」「新的」「1」。
                    */}
                  al_{t.visible}… · {t.scopes.join("、")}
                  {t.lastUsedAt ? " · 最近用过" : " · 还没用过"}
                </p>
                {/*
                  * 用量。只写上限不写用量的话，撞限流的人第一反应是
                  * 「是不是坏了」，而不是「我发太多了」。
                  */}
                {usage[t.id] && usage[t.id].day > 0 && (
                  <p className="t-caption2 text-[var(--ink-quaternary)]">
                    今天发了 {usage[t.id].day}/{limits.perDay} 条 · 这小时{" "}
                    {usage[t.id].hour}/{limits.perHour}
                  </p>
                )}
              </div>
              <button
                type="button"
                disabled={pending}
                onClick={() => revoke(t.id)}
                className="tap-target t-caption2 shrink-0 text-[var(--ink-tertiary)] transition active:opacity-60 disabled:opacity-45"
                aria-label={`撤销令牌 ${t.name}`}
              >
                <Trash2 className="h-4 w-4" strokeWidth={2} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
